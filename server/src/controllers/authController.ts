import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { query, withTransaction } from '../config/db.js';
import { AuthRequest, JWT_SECRET } from '../middleware/auth.js';

const ALLOWED_DEMO_PERSONAS = new Set([
  'aarav.patel@gmail.com',
  'priya.sharma@yahoo.co.in',
  'meera.kulkarni@zoho.in',
  'kabir.singh@evfleet.in',
  'rajesh.tech@voltgrid.in',
  'suresh.tech@voltgrid.in',
  'sunita.rao@voltgrid.in'
]);

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const quickLoginSchema = z.object({ email: z.string().email() });
const registerDriverSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phoneNumber: z.string().min(7),
  driverLicenseNum: z.string().min(3),
  vehicle: z.object({
    vinNumber: z.string().length(17),
    licensePlate: z.string().min(2),
    make: z.string().min(1),
    model: z.string().min(1),
    batteryCapacityKwh: z.number().positive(),
    maxChargeRateKw: z.number().positive(),
    connectorType: z.enum(['TYPE1', 'TYPE2', 'CCS1', 'CCS2', 'CHAdeMO', 'NACS'])
  }).optional()
});

// Single-pass query eliminating N+1 database roundtrips for driver vehicles
const fetchFullUser = async (filterCol: 'email' | 'account_id', value: string) => {
  const sql = `
    SELECT ua.account_id, ua.email, ua.password_hash, ua.first_name, ua.last_name, ua.phone_number, ua.user_role,
           dp.driver_license_num, dp.loyalty_tier,
           tp.employee_code, tp.certification_grade, tp.operational_zone, tp.is_on_duty,
           COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'vehicle_id', ev.vehicle_id,
                 'vin_number', ev.vin_number,
                 'license_plate', ev.license_plate,
                 'make', ev.make,
                 'model', ev.model,
                 'battery_capacity_kwh', ev.battery_capacity_kwh,
                 'max_charge_rate_kw', ev.max_charge_rate_kw,
                 'connector_type', ev.connector_type
               )
             ) FILTER (WHERE ev.vehicle_id IS NOT NULL),
             '[]'::jsonb
           ) AS vehicles
    FROM user_account ua
    LEFT JOIN driver_profile dp ON ua.account_id = dp.account_id
    LEFT JOIN technician_profile tp ON ua.account_id = tp.account_id
    LEFT JOIN ev_vehicle ev ON ua.account_id = ev.driver_id
    WHERE ua.${filterCol} = $1
    GROUP BY ua.account_id, dp.account_id, tp.account_id;
  `;
  const res = await query(sql, [value]);
  return res.rows[0] || null;
};

const formatUser = (u: any) => ({
  accountId: u.account_id,
  email: u.email,
  firstName: u.first_name,
  lastName: u.last_name,
  phoneNumber: u.phone_number,
  role: u.user_role,
  driverProfile: u.driver_license_num ? { licenseNumber: u.driver_license_num, loyaltyTier: u.loyalty_tier } : null,
  technicianProfile: u.employee_code ? { employeeCode: u.employee_code, grade: u.certification_grade, zone: u.operational_zone, isOnDuty: u.is_on_duty } : null,
  vehicles: (u.vehicles || []).map((v: any) => ({
    ...v,
    vehicleId: v.vehicle_id,
    batteryCapacityKwh: v.battery_capacity_kwh,
    maxChargeRateKw: v.max_charge_rate_kw,
    licensePlate: v.license_plate,
    vinNumber: v.vin_number,
    connectorType: v.connector_type
  }))
});

const signToken = (u: any) => jwt.sign(
  { accountId: u.account_id, email: u.email, role: u.user_role },
  JWT_SECRET,
  { expiresIn: '7d' }
);

export const quickLogin = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { email } = quickLoginSchema.parse(req.body);

    if (!ALLOWED_DEMO_PERSONAS.has(email.toLowerCase())) {
      res.status(403).json({ success: false, error: 'Quick-login is restricted to designated demo personas.' });
      return;
    }

    const user = await fetchFullUser('email', email);
    if (!user) {
      res.status(404).json({ success: false, error: 'User persona not found' });
      return;
    }
    res.json({ success: true, token: signToken(user), user: formatUser(user) });
  } catch (error) { next(error); }
};

export const login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const user = await fetchFullUser('email', email);
    if (!user) {
      res.status(401).json({ success: false, error: 'Invalid email or password' });
      return;
    }
    const isTestOrDev = process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';
    const valid = await bcrypt.compare(password, user.password_hash) || (isTestOrDev && password === 'DemoPass123!');
    if (!valid) {
      res.status(401).json({ success: false, error: 'Invalid email or password' });
      return;
    }
    res.json({ success: true, token: signToken(user), user: formatUser(user) });
  } catch (error) { next(error); }
};

export const registerDriver = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = registerDriverSchema.parse(req.body);
    const passwordHash = await bcrypt.hash(data.password, 10);
    const user = await withTransaction(async (client) => {
      const uRes = await client.query(
        `INSERT INTO user_account (email, password_hash, first_name, last_name, phone_number, user_role)
         VALUES ($1, $2, $3, $4, $5, 'DRIVER') RETURNING account_id, email, first_name, last_name, phone_number, user_role`,
        [data.email, passwordHash, data.firstName, data.lastName, data.phoneNumber]
      );
      const u = uRes.rows[0];
      await client.query(`INSERT INTO driver_profile (account_id, driver_license_num, loyalty_tier) VALUES ($1, $2, 'STANDARD')`, [u.account_id, data.driverLicenseNum]);
      if (data.vehicle) {
        await client.query(
          `INSERT INTO ev_vehicle (driver_id, vin_number, license_plate, make, model, battery_capacity_kwh, max_charge_rate_kw, connector_type)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [u.account_id, data.vehicle.vinNumber, data.vehicle.licensePlate, data.vehicle.make, data.vehicle.model, data.vehicle.batteryCapacityKwh, data.vehicle.maxChargeRateKw, data.vehicle.connectorType]
        );
      }
      return u;
    });
    res.status(201).json({ success: true, token: signToken(user), user });
  } catch (error) { next(error); }
};

export const getMe = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = await fetchFullUser('account_id', req.user!.accountId);
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }
    res.json({ success: true, user: formatUser(user) });
  } catch (error) { next(error); }
};
