import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { pool, query } from '../config/db.js';
import { AuthRequest } from '../middleware/auth.js';
import { broadcastTicketUpdate, broadcastBayStatusUpdate } from '../sockets/socketHandler.js';

const createTicketSchema = z.object({
  bayId: z.string().uuid(),
  faultCategory: z.string().min(2),
  severityLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  description: z.string().min(5)
});

const notifyBay = async (bayId: string, status: string) => {
  const res = await pool.query(`SELECT station_id FROM charging_bay WHERE bay_id = $1`, [bayId]);
  if (res.rows.length > 0) broadcastBayStatusUpdate(res.rows[0].station_id, bayId, status);
};

export const getTickets = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { status, bayId } = req.query;
    const params: any[] = [];
    const conditions: string[] = ['1=1'];

    if (status) { params.push(status); conditions.push(`mt.ticket_status = $${params.length}`); }
    if (bayId) { params.push(bayId); conditions.push(`mt.bay_id = $${params.length}`); }

    const sql = `
      SELECT mt.ticket_id, mt.bay_id, mt.fault_category, mt.severity_level, mt.ticket_status,
             mt.description, mt.reported_at, mt.resolved_at, cb.bay_number, cs.station_id, cs.station_name, cs.city,
             driver_user.first_name || ' ' || driver_user.last_name AS reported_by_name,
             driver_user.email AS reported_by_email,
             tech_user.first_name || ' ' || tech_user.last_name AS assigned_technician_name,
             tp.employee_code AS technician_code
      FROM maintenance_ticket mt
      JOIN charging_bay cb ON mt.bay_id = cb.bay_id
      JOIN charging_station cs ON cb.station_id = cs.station_id
      LEFT JOIN user_account driver_user ON mt.reported_by_driver_id = driver_user.account_id
      LEFT JOIN user_account tech_user ON mt.assigned_technician_id = tech_user.account_id
      LEFT JOIN technician_profile tp ON mt.assigned_technician_id = tp.account_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY mt.reported_at DESC;
    `;
    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (error) { next(error); }
};

export const createTicket = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { bayId, faultCategory, severityLevel, description } = createTicketSchema.parse(req.body);
    const driverId = req.user?.role === 'DRIVER' ? req.user.accountId : null;

    const insertRes = await query(
      `INSERT INTO maintenance_ticket (bay_id, reported_by_driver_id, fault_category, severity_level, ticket_status, description)
       VALUES ($1, $2, $3, $4, 'OPEN', $5) RETURNING *;`,
      [bayId, driverId, faultCategory, severityLevel, description]
    );
    const ticket = insertRes.rows[0];

    await notifyBay(bayId, 'MAINTENANCE');
    broadcastTicketUpdate(ticket);

    res.status(201).json({ success: true, data: ticket });
  } catch (error) { next(error); }
};

export const claimTicket = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const updateRes = await query(
      `UPDATE maintenance_ticket SET assigned_technician_id = $1, ticket_status = 'IN_PROGRESS'
       WHERE ticket_id = $2 AND ticket_status = 'OPEN' RETURNING *;`,
      [req.user!.accountId, req.params.id]
    );
    if (updateRes.rows.length === 0) {
      res.status(400).json({ success: false, error: 'Ticket not found or already claimed/resolved' });
      return;
    }
    const ticket = updateRes.rows[0];
    broadcastTicketUpdate(ticket);
    res.json({ success: true, data: ticket });
  } catch (error) { next(error); }
};

export const resolveTicket = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const updateRes = await query(
      `UPDATE maintenance_ticket SET ticket_status = 'RESOLVED', resolved_at = CURRENT_TIMESTAMP
       WHERE ticket_id = $1 AND (assigned_technician_id = $2 OR $3 = 'ADMIN') AND ticket_status IN ('OPEN', 'IN_PROGRESS')
       RETURNING *;`,
      [req.params.id, req.user!.accountId, req.user?.role]
    );
    if (updateRes.rows.length === 0) {
      res.status(400).json({ success: false, error: 'Ticket not found, not assigned to you, or already resolved' });
      return;
    }
    const ticket = updateRes.rows[0];
    await notifyBay(ticket.bay_id, 'AVAILABLE');
    broadcastTicketUpdate(ticket);
    res.json({ success: true, data: ticket });
  } catch (error) { next(error); }
};
