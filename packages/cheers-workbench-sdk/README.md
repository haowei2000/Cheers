# Cheers Workbench SDK

Write personal macOS renderers in TypeScript and package them with declarative scenes.

```bash
npm install
npm run build
cheers-workbench pack examples/scene-renderer
```

The packer bundles each `src/renderers/<id>.ts[x]` entry as a single IIFE and writes a deterministic `.cheers-extension` ZIP. Renderer code only runs on macOS after installation confirmation and selection. Browser and iOS clients consume scenes but never execute extension code.

`examples/scene-renderer` combines a scene, seed file, and minimal writable renderer. `examples/network-renderer` demonstrates the explicit `network: unrestricted` permission and install warning.

`contributes.automations` declares inert scheduled-message templates. Each template has
an ID, title, message, and either an interval or daily `defaultSchedule`. Daily templates
may omit the timezone so Cheers uses the creating user's local IANA timezone.
Installation never starts an Automation; a user selects the channel, optional bot, and
schedule in Cheers. The scene-renderer example includes a daily notes-review template.
