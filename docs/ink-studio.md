# Ink Studio for Web Game prototypes

Ink Studio builds procedural pixel-art scenes and renders them with WebGL 2. The bundled workflow is intended for small, playable static Web Game prototypes. The project contains editable HTML, CSS, JavaScript, and the browser runtime it uses.

## Start a prototype

1. In **Plugins → Game creation**, enable **Ink Studio**.
2. Open its details and choose **Try now**, then select or create a Web Game. This enables Ink Studio for the selected project and opens a draft. Edit the example or describe your own gameplay before sending it.
3. In an existing Web Game, select **Ink Studio** from the composer’s `@` menu and send the request. Sending the selected mention enables Ink Studio for that project.
4. Open **Play** to test the result. Ask for the next change in the same conversation, for example “extend the warning by half a second.”

**Project settings → Ink Studio** controls the selected project's access to the guide and installation tool. The application-wide switch is in **Plugins**. Existing game files use relative imports and continue to play from their project folder. An exported game can be served by an ordinary static HTTP server. The browser modules are available without a network connection. A remote Agent still needs access to its configured text-model provider.

## Runtime and verification

The local tool `ensure_ink_runtime` takes no arguments. It validates the packaged files, checks the projected project-source budget, and installs the browser modules, license, notice, and manifest together under the game's startup directory. The tool reuses a valid existing build and reports conflicts without replacing project files. It returns workspace-relative paths for the toolkit, renderer and manifest. A new game can start in an empty static workspace. For script or command previews, use a separate static Web Game for the prototype.

The prepared browser modules use the pinned upstream **bake** profile and WebGL 2 renderer. The [browser API reference](../plugins/ink-studio/skills/ink-studio/references/browser-api.md) describes the supported scene APIs. The project owns input, simulation and gameplay rules. Inspect the actual page and real input through [game use](runtime.md#agent-game-use) before claiming a playable result.

The [runtime manifest](../plugins/ink-studio/runtime/runtime-manifest.json) records the source commit, build inputs and file checksums. To reproduce the artifacts, pass the reviewed source archive to `node scripts/prepare-ink-runtime.mjs <archive> <output-directory>`. This is a maintainer command. User projects receive the already-built modules with the plugin.

The source for the original **Tide Circuit** acceptance game is in [the fixture](../test/fixtures/ink-studio/). It covers keyboard movement, a bounded telegraph and wave, loss, a full 30-second win and restart. For an acceptance project, install the bundled runtime through the normal Ink Studio tool before copying in this fixture's game files.

For more complex games, build and check the first frame, player, projectile, enemies, and Boss parts in stages. The [dynamic scene fixture](../test/fixtures/ink-studio/dynamic-scene.mjs) and [browser page](../test/fixtures/ink-studio/dynamic.html) show independent moving parts and a reusable projectile pool; its Node regression checks scene data, while actual visibility and gameplay still require Electron playtesting. The [browser API reference](../plugins/ink-studio/skills/ink-studio/references/browser-api.md#dynamic-scene-and-material-checks) covers palette validation, bake grouping, shadow/AO limits, error diagnosis, and safe temporary probes.
