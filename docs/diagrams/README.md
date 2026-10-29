# Architecture infographic assets

Repository-local, editable SVG artwork. These are illustrations, not application screenshots. Each infographic has an explicit light/dark pair; embed the pair with a picture element and descriptive alternative text.

- `core-overview-*`: the analytical library, with caller responsibilities distinguished.
- `application-overview-*`: preview application components and data paths from PR #10 and #13.
- `ai-boundaries-*`: PR #13 model payloads, server-side key handling and local-versus-remote routing.

The source map and accessible text/diagrams are in [ARCHITECTURE-DIAGRAMS.md](../ARCHITECTURE-DIAGRAMS.md). Update both themes and that source map when behavior changes. Keep the core/application responsibilities clear and retain engineering-preview status until production validation is complete.
