# Cheers landing page

A self-contained, single-file landing/overview site for Cheers, aimed at both
users and developers. No build step and no external dependencies — `index.html`
inlines all CSS and JS, so it works offline and on any static host.

## Preview locally

```bash
# just open it
open website/index.html          # macOS

# or serve it (nicer for testing relative behavior)
python3 -m http.server -d website 8080   # → http://localhost:8080
```

## Deploy

Any static host works. For **GitHub Pages**, either:

- set Pages source to the `/website` folder on your default branch, or
- copy `index.html` to the repo root / a `docs/` Pages source.

## Notes

- Light/dark theme follows the OS by default; the ◐ button cycles
  auto → light → dark and remembers the choice.
- Documentation and repo links point at `https://github.com/haowei2000/Cheers`
  — update them if the canonical repo URL changes.
- Content is intentionally kept in sync with `README.md`; when features or the
  stack change, update both.
