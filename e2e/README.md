# End-to-end tests

Empty on purpose, and worth being honest about: there are no Playwright specs
in this repository yet. The config that referenced them pointed at a package
that was never installed, so nothing here has ever run in CI.

The config now loads and `npx playwright test` runs cleanly against an empty
suite. Specs added here get a built app served at `http://localhost:4173`
automatically; point `E2E_BASE_URL` at a deployment to run against that instead.

The first ones worth writing are the boundaries this repo has no automated
coverage for at all:

  - a signed-out visitor is redirected away from a protected route
  - notes written by one account are not visible after signing in as another
    on the same browser (regression test for the fixed sticky-note leak)
  - a rotated API key stops authenticating once its grace period ends
