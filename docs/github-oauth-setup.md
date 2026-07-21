# GitHub OAuth App setup

EverFree uses the existing GitHub OAuth App Device Flow. Device Flow must be
enabled and the app must request the `repo` scope so EverFree can create and
sync the private `everfree-notes` repository.

The OAuth grant is broader than one repository because GitHub does not provide
a single-repository OAuth scope. EverFree compensates in application code:
repository names are fixed to `everfree-notes`, repository objects are checked,
and Git remotes are credential-free and checked before use.

Do not create or distribute a GitHub App private key. Do not add a repository
picker or accept a custom repository name.

The public client ID may be supplied as `EVERFREE_GITHUB_CLIENT_ID`; packaged
builds use the existing OAuth client ID by default.
