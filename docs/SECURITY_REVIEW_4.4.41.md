# VideoKit 4.4.41 security maintenance

Compatible fixes: trusted main-frame IPC checks, external-navigation restrictions, text-only overlay binding options, HTTPS-only portable update redirects, dangling-symlink extraction guard, pinned GitHub Actions, http-cache-semantics 4.3.0, source-map-js 1.2.2, multidict >=6.9.1,<7.

The http-cache-semantics advisory is disputed by its maintainer; the compatible update removes the npm advisory match but is not evidence that this application leaked cached data.

npm audit after compatible updates reports 12 dependency nodes (3 high, 9 moderate), including Electron 33, Vite 5, extract-zip 2.0.1 and their dependency chains. Major upgrades and archive-library replacement are explicitly deferred by the maintainer. Elevated render workers, broad local-media access, legacy Python HTTP API authorization and portable-update signature verification remain follow-up work.

Local checks passed: production web build; queue/Groq, Edge adapter, batch-preview/follow, scroll-duration and color-preset regressions; normal ZIP/symlink rejection; trusted-origin/HTML/HTTPS redirect tests. An isolated Electron run verified preset hydration and rejection of an untrusted IPC caller.

Do not interpret this maintenance release as a vulnerability-free attestation. No API credentials or user task media belong in the repository or release artifacts.
