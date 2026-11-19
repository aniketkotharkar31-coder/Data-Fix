import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createApiRouter } from './server/routes/api.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const port = Number(process.env.PORT ?? 3000);

  app.use(express.json({ limit: '25mb' }));
  app.use('/api', createApiRouter());

  // Catch-all for unmatched /api/* routes so they never fall through to Vite/SPA HTML
  app.use('/api', (req, res) => {
    res.status(404).json({
      error: `API endpoint not found: ${req.method} ${req.originalUrl}`,
      code: 'API_NOT_FOUND',
    });
  });

  // Global Express JSON error-handling middleware for /api/* routes
  app.use(
    (
      err: Error & { status?: number; statusCode?: number; type?: string; code?: string },
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      const isApiRequest =
        req.originalUrl.startsWith('/api') || req.path.startsWith('/api');
      if (isApiRequest) {
        if (res.headersSent) {
          next(err);
          return;
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({
            error: 'Uploaded file exceeds the 25 MB server limit.',
            code: 'FILE_TOO_LARGE',
          });
          return;
        }
        const status =
          err.type === 'entity.parse.failed'
            ? 400
            : typeof err.statusCode === 'number' && err.statusCode >= 400
              ? err.statusCode
              : typeof err.status === 'number' && err.status >= 400
                ? err.status
                : 500;
        res.status(status).json({
          error:
            err.type === 'entity.parse.failed'
              ? 'Invalid JSON request payload.'
              : err.message || 'Internal server error.',
          code: err.code ?? 'INTERNAL_SERVER_ERROR',
        });
        return;
      }
      next(err);
    }
  );

  if (process.env.NODE_ENV === 'production') {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`DataFix server running on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start DataFix server:', err);
  process.exit(1);
});
