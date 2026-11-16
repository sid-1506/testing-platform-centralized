import { Router } from 'express';
import { getRegisteredApp, loadRegistry } from '../services/registry';
import { inspectApplication } from '../services/inspector';

export const appsRouter = Router();

appsRouter.get('/', (_req, res) => {
  const apps = loadRegistry().map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    sourcePath: a.sourcePath,
    suitePath: a.suitePath,
    ports: a.startup.ports,
    suites: a.suites,
  }));
  res.json({ apps });
});

appsRouter.get('/:id/inspect', (req, res) => {
  const app = getRegisteredApp(req.params.id);
  if (!app) {
    res.status(404).json({ error: `Application '${req.params.id}' not found` });
    return;
  }
  const report = inspectApplication(app);
  res.json(report);
});
