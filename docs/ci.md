## Continuous Integration & Publishing

This repo ships with two GitHub Actions workflows so new contributors immediately understand how their code moves from a PR to a prerelease package.

### `build-wasm.yml`: build and test every pull request

Location: `.github/workflows/build-wasm.yml`. It runs on pull requests to `main`, and `publish.yml` calls it before packing.

- **build-wasm** rebuilds the guest with `ScriptBox.Wasm/docker-build.sh` and fails if it or `artifacts.json` differ from what is committed. It uploads them as `scriptbox-wasm`.
- **build-and-test** builds the .NET solution and runs the ScriptBox and Semantic Kernel tests.
- **node** checks that `ScriptBox.Node/src/generated/build-info.ts` matches the artifacts, then builds, type-checks, lints and tests the Node package. Last, it packs the tarball and runs it in a clean Node 24 container with the network off.

Nothing in this workflow publishes the npm package.

### `publish.yml` – Publish NuGets on Release

Location: `.github/workflows/publish.yml`

- **Triggers**: 
  - Publishing a GitHub Release.
  - Pushing any tag starting with `v` (e.g., `v1.0.0`, `v0.2.0-beta.1`).
- **Steps**:
  1. Checkout with full history (`fetch-depth: 0`) so future versioning tools work.
  2. Install .NET 9 and .NET 10 SDKs.
  3. Restore all dependencies.
  4. Extract the package version from the tag name (strip the leading `v`).
  5. Pack `ScriptBox/ScriptBox.csproj` with `/p:PackageVersion=<tag>` into `out/`.
  6. Pack `ScriptBox.DependencyInjection/ScriptBox.DependencyInjection.csproj` with the same version into `out/`.
  7. `dotnet nuget push out/*.nupkg --source https://api.nuget.org/v3/index.json --api-key ${{ secrets.NUGET_API_KEY }}` publishes both packages (core + DI helpers).
- **Secrets**: set `NUGET_API_KEY` (nuget.org API key) under **Settings → Secrets and variables → Actions**.
- **Flow**: 
  - Create a new Release in GitHub with a tag like `v1.0.0` (for stable) or `v1.0.0-beta.1` (for prerelease).
  - The workflow will automatically build and publish the packages to NuGet.

### FAQs

- **How do I publish a stable release?** Simply create a GitHub Release with a stable version tag (e.g., `v1.0.0`). The workflow now handles both stable and prerelease tags.
- **What if the workflow fails?** Open the Actions tab, inspect the failed job, fix the issue, and push a new tag (e.g., increment the patch version).
- **Can I publish to GitHub Packages instead?** Replace the final `dotnet nuget push` step with the GitHub Packages command (instructions in `docs/ci.md`).

This file should give new contributors everything they need to understand our CI/publishing pipeline without reading the workflow YAML inside `.github/workflows/`.
