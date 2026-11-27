# Linux NVIDIA renderer freeze

Confirmed on 27 November 2026: Zorin 18, X11, RTX 2060 SUPER, NVIDIA 580.196.11, bundled WebKitGTK.

The `KNIGHTLIGHT_GPU_RENDERER=nvidia` launch optimization enabled WebKit's DMABUF renderer. Section transitions leaked `anon_inode:sync_file` graphics synchronization descriptors. Once the WebKit content process approached GNOME's normal 1,024-descriptor soft limit, it stopped processing input and repainting. The main application remained open. This explains why the freeze appeared on different sections and required closing the app.

Kernel messages at the two reported freezes included `Failed to create sync file from fence` and `Attempt to wait on invalid sync FD: -24`. Error 24 is `EMFILE`, the per-process descriptor limit. A matching [upstream issue](https://github.com/unslothai/unsloth/issues/10795) documents this NVIDIA/WebKit failure.

## Controlled reproduction

Both runs used the same extracted installed AppImage, a disposable copy of the user's history, an isolated Xvfb display, real XTest clicks, and a WebKit view verified muted before loading. The file-descriptor soft limit was set to 1,024 to match the desktop launcher.

| Configuration | Renderer descriptors | Leaked sync handles | Result |
| --- | --- | --- | --- |
| NVIDIA DMABUF enabled | About 70 → 1,007 | Peaked at 925 | Stalled after 20 accepted section clicks |
| Compatible renderer | Peaked at 44; ended at 40 | 0 throughout | All 240 section clicks accepted |

The earlier agent/CI shell used a limit of 1,048,576, which concealed the failure in short runs. Earlier native smoke tests also changed sections synchronously without waiting for rendering; most transitions never reached the compositor.

## Resolution and regression coverage

The installed launcher now uses `WEBKIT_DISABLE_DMABUF_RENDERER=1` by default. AppImage startup no longer honors the unsafe `KNIGHTLIGHT_GPU_RENDERER=nvidia` opt-in. Explicit WebKit environment overrides remain available for diagnostics. Game data and audio preferences are unchanged.

`tests/desktop-window.py` now launches at the 1,024-descriptor limit and samples the renderer's descriptors, failing early if graphics sync handles accumulate. The native smoke check renders 100 section changes per launch, including Settings, and then checks the board and both audio pipelines. It runs twice to verify settings and the local-storage origin survive relaunch. Use Xvfb and disposable profiles; desktop input automation requires explicit user readiness and an immediate stop on lost focus.

Raising the descriptor limit would only postpone the freeze; it does not repair the leak. Hardware acceleration can be reconsidered after the graphics stack is fixed and sustained resource measurements show that descriptors remain bounded.
