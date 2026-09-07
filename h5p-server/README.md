# H5P Server

A ready-to-use H5P content server for integration with external applications.

## What This Server Provides

The `@lumieducation/h5p-server` npm package provides H5P's core functionality (content storage, library management, editor/player rendering), and `@lumieducation/h5p-express` provides AJAX endpoints for the H5P client-side JavaScript. However, as [the Lumi docs note](https://docs.lumi.education/usage/ajax-endpoints):

> **The Express adapter does not include pages to create, edit, view, list or delete content!**

This server wraps those libraries into a **complete HTTP service** with:

### User-Facing Pages

| Endpoint | Description |
|----------|-------------|
| `GET /new` | H5P editor for creating new content |
| `POST /new` | Save new content |
| `GET /edit/:id` | H5P editor for existing content |
| `POST /edit/:id` | Update existing content |
| `GET /play/:id` | H5P player with xAPI tracking |

### Content Management API

| Endpoint | Description |
|----------|-------------|
| `GET /api/content` | List all content with metadata |
| `GET /api/content/:id` | Get single content metadata |
| `DELETE /api/content/:id` | Delete content |
| `GET /api/content-types` | List available H5P content types |

### Integration Features

| Feature | Description |
|---------|-------------|
| `returnUrl` param | Redirect back to your app after save with `?contentId=X&title=Y` |
| `webhookUrl` param | POST xAPI scores to your application's webhook endpoint |
| `postMessage` | Send xAPI events to parent window (for iframe embedding) |
| `userId` param | Track which user is interacting with content |

### Production Readiness

- Docker image with health checks
- Non-root user for security
- Volume mounts for data persistence
- CORS configured for cross-origin embedding
- Cross-origin iframe fixes for H5P's parent window access

### Security Scanning

The image is meant to pass a vulnerability scan (Trivy, Grype, ...) without HIGH or
CRITICAL findings. Reproduce the scan of the admins with:

```bash
docker compose -f docker-compose.prod.yml build --pull --no-cache
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:latest \
    image --severity HIGH,CRITICAL h5p-server_image
```

What keeps the image clean:

- `node:24-alpine` as base plus `apk upgrade` in the Dockerfile, so the OpenSSL fixes
  published after the base image was built are included. Docker caches that layer,
  so build deployments with `--pull --no-cache`, otherwise the fixes of the day are
  not picked up
- `npm ci` prints "3 high severity vulnerabilities" during the build - that is the
  `image-size` finding described below, nothing else
- npm, npx and corepack are removed from the runtime image. Their bundled
  dependencies (`tar`, `minimatch`, `glob`, ...) were the bulk of the findings, and the
  server is started with `node` directly
- pinned `overrides` in `package.json` for transitive packages that the H5P server
  does not update itself (`qs`, `sanitize-html`, `nanoid`, ...) - check them with
  `npm audit --omit=dev` after an update

Known finding without a fix: `image-size` (CVE-2025-71329, CVE-2025-71330, all
released versions affected). The H5P editor calls it for every upload declared as an
image, and crafted ICNS/JXL/HEIF files hang the event loop. The server disables those
parsers at startup in [src/index.js](src/index.js), so the finding is mitigated even
though scanners keep reporting the package. Remove the workaround once
`@lumieducation/h5p-server` depends on a fixed release.

## Quick Start

### Using Node.js

```bash
npm install
npm start
# Server running at http://localhost:3000
```

### Using Docker

```bash
docker build -t h5p-server .
docker run -p 3000:3000 -v ./h5p:/data/h5p h5p-server
```

Or via docker-compose from the project root:

```bash
docker compose up -d h5p-server
```

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `H5P_BASE_URL` | `http://localhost:3000` | Public URL (for asset URLs in rendered HTML) |
| `H5P_DATA_PATH` | `./h5p` | Path to H5P data directory |

## Integration Pattern

### Creating Content

```
1. Open popup/iframe to: http://localhost:3000/new?returnUrl=http://yourapp/callback
2. User creates content in H5P editor
3. User clicks Save
4. Server redirects to: http://yourapp/callback?contentId=abc123&title=My%20Quiz
5. Your app stores the contentId
```

### Playing Content

```
1. Embed iframe: http://localhost:3000/play/abc123?userId=user1&webhookUrl=http://yourapp/webhook
2. User interacts with content
3. On completion, server POSTs to your webhook:
   {
     "contentId": "abc123",
     "userId": "user1",
     "statement": { /* xAPI statement */ }
   }
4. Also sends postMessage to parent window (if embedded in iframe)
```

### xAPI Events

The player tracks these xAPI verbs:
- `completed` - User finished the content
- `answered` - User answered a question
- `passed` - User passed (score above threshold)
- `failed` - User failed (score below threshold)

Webhook payload example:

```json
{
  "contentId": "abc123",
  "userId": "demo-user",
  "statement": {
    "verb": { "id": "http://adlnet.gov/expapi/verbs/completed" },
    "result": {
      "score": { "raw": 8, "max": 10 },
      "completion": true
    }
  }
}
```

## Directory Structure

```
h5p-server/
├── src/
│   └── index.js          # Express server (~750 lines)
├── h5p/                   # H5P data directory
│   ├── core/             # H5P player core files
│   ├── editor/           # H5P editor core files
│   ├── libraries/        # Downloaded content type libraries
│   ├── content/          # Saved content
│   └── temp/             # Temporary upload files
├── package.json
├── Dockerfile
└── README.md
```

## License

GPL-3.0-or-later (due to @lumieducation/h5p-server dependency)

See the main project README for licensing details on the example applications.
