import { NextFunction, Request, Response, Router } from 'express';
import { param } from '../lib/params';
import { listRepos } from '../services/repoRegistry';
import { DiscoveryError, startDiscovery } from '../services/testDiscovery';
import { toPublicRepo } from '../services/repoSettings';
import {
  RepoServiceError,
  deleteRepository,
  inspectRepository,
  refetchRepository,
  registerRepository,
  requireRepo,
  revokeTrust,
  trustRepository,
  updateRepositorySettings,
} from '../services/repoService';

export const reposRouter = Router();

function handle(fn: (req: Request, res: Response) => Promise<void> | void) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof RepoServiceError || err instanceof DiscoveryError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  };
}

reposRouter.get('/', (_req, res) => {
  res.json({ repos: listRepos().map(toPublicRepo) });
});

reposRouter.post(
  '/',
  handle(async (req, res) => {
    const { url, branch } = (req.body ?? {}) as { url?: unknown; branch?: unknown };
    if (typeof url !== 'string') throw new RepoServiceError(400, 'url is required.', 'INVALID_URL');
    if (branch !== undefined && typeof branch !== 'string') throw new RepoServiceError(400, 'branch must be a string.', 'INVALID_BRANCH');
    const repo = await registerRepository(url, (branch as string | undefined) || 'main');
    res.status(202).json({ repo: toPublicRepo(repo) });
  })
);

reposRouter.get(
  '/:id',
  handle((req, res) => {
    res.json({ repo: toPublicRepo(requireRepo(param(req, 'id'))) });
  })
);

reposRouter.delete(
  '/:id',
  handle((req, res) => {
    deleteRepository(param(req, 'id'));
    res.json({ deleted: true });
  })
);

reposRouter.post(
  '/:id/fetch',
  handle((req, res) => {
    res.status(202).json({ repo: toPublicRepo(refetchRepository(param(req, 'id'))) });
  })
);

/** Starts test discovery (framework-native listing, no test is executed). Poll GET /:id/discovery or GET /:id. */
reposRouter.post(
  '/:id/discover',
  handle((req, res) => {
    res.status(202).json({ repo: toPublicRepo(startDiscovery(param(req, 'id'))) });
  })
);

reposRouter.get(
  '/:id/discovery',
  handle((req, res) => {
    const repo = toPublicRepo(requireRepo(param(req, 'id')));
    res.json({ state: repo.discoveryState ?? null, discovery: repo.discovery ?? null, commitSha: repo.commitSha });
  })
);

reposRouter.post(
  '/:id/inspect',
  handle((req, res) => {
    res.json({ repo: toPublicRepo(inspectRepository(param(req, 'id'))) });
  })
);

reposRouter.post(
  '/:id/trust',
  handle((req, res) => {
    res.json({ repo: toPublicRepo(trustRepository(param(req, 'id'))) });
  })
);

reposRouter.delete(
  '/:id/trust',
  handle((req, res) => {
    res.json({ repo: toPublicRepo(revokeTrust(param(req, 'id'))) });
  })
);

reposRouter.patch(
  '/:id/settings',
  handle((req, res) => {
    res.json({ repo: toPublicRepo(updateRepositorySettings(param(req, 'id'), req.body)) });
  })
);
