import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthRequest extends Request {
  user?: {
    accountId: string;
    email: string;
    role: 'DRIVER' | 'TECHNICIAN' | 'ADMIN';
  };
}

export const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_voltgrid_jwt_key_2026_change_in_prod';

export const authenticateToken = (req: AuthRequest, res: Response, next: NextFunction): void => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    res.status(401).json({ success: false, error: 'Access token required' });
    return;
  }

  jwt.verify(token, JWT_SECRET, (err, decoded: any) => {
    if (err) {
      res.status(403).json({ success: false, error: 'Invalid or expired token' });
      return;
    }
    req.user = decoded;
    next();
  });
};

export const requireRole = (...roles: Array<'DRIVER' | 'TECHNICIAN' | 'ADMIN'>) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({ 
        success: false, 
        error: `Unauthorized role: ${req.user.role}. Required: ${roles.join(' or ')}` 
      });
      return;
    }

    next();
  };
};
