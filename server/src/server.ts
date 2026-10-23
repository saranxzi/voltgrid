import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';

import { pool } from './config/db.js';
import { initSocket } from './sockets/socketHandler.js';
import { errorHandler } from './middleware/error.js';
import { apiRouter } from './routes.js';

dotenv.config();

const app = express();
const server = http.createServer(app);

const allowedOrigins = process.env.CLIENT_URL
  ? process.env.CLIENT_URL.split(',').map((s) => s.trim())
  : ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:5000'];

const isOriginAllowed = (origin?: string): boolean => {
  if (!origin) return true;
  if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return true;
  // Allow local network and private IP ranges for dev/lab setups
  const isPrivateDev = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/.test(origin);
  return process.env.NODE_ENV !== 'production' && isPrivateDev;
};

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS: Origin blocked by policy'));
    }
  },
  credentials: true
};

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) {
        callback(null, true);
      } else {
        callback(new Error('CORS: Socket origin blocked by policy'));
      }
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    credentials: true
  }
});

initSocket(io);

app.use(cors(corsOptions));
app.use(express.json());
app.use('/api', apiRouter);

app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.get('/api/health', async (_req, res) => {
  try {
    const dbCheck = await pool.query('SELECT 1 AS healthy;');
    res.json({
      status: 'UP',
      timestamp: new Date().toISOString(),
      database: dbCheck.rows.length > 0 ? 'CONNECTED' : 'DISCONNECTED'
    });
  } catch (error: any) {
    res.status(503).json({
      status: 'DOWN',
      timestamp: new Date().toISOString(),
      databaseError: error.message
    });
  }
});

app.use(errorHandler);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 VoltGrid DBMS API Server running on http://localhost:${PORT} (PostgreSQL @ ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || '5432'})`);
});
