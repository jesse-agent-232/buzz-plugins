# buzz-plugins

Buzz desktop plugins, one folder each under `plugins/`.

| Plugin | What it does |
|---|---|
| [`plugins/remote-agents/`](plugins/remote-agents/README.md) | A **Remote** agent type: create, rename and remove agents that run on your own server, which keeps their keys |
| [`plugins/plane/`](plugins/plane/README.md) | A self-hosted Plane workspace: a board page, your open cards in the sidebar, and card link previews whose state you can move |

A plugin's `manifest.json` names placeholder origins (`*.example.com`). Put in
your own before installing from a folder, or install from a server that
serves the plugin with its origin stamped in.
