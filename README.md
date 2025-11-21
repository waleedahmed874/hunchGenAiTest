# Express.js Traits API Server

A Node.js Express.js server for processing traits data and queuing tasks to Google Cloud Tasks for ML processing.

## Setup

### Prerequisites
- Node.js (v14 or higher)
- npm or yarn
- Google Cloud Project with Cloud Tasks API enabled
- Service Account with proper permissions

### Installation

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables in `.env`:
```env
# Google Cloud Configuration
GCLOUD_PROJECT=your-project-id
GCLOUD_LOCATION=us-central1
GCLOUD_QUEUE_TRAITS=trait-tasks-queue
GCLOUD_SERVICE_ACCOUNT_EMAIL=your-service-account@your-project.iam.gserviceaccount.com
ML_CALLBACK_BASE=https://your-api.com

# Server Configuration
PORT=3000
```

3. Start the server:
```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

## API Endpoints

### Base Routes

#### GET `/`
Welcome endpoint showing server status.

**Response:**
```json
{
  "message": "Welcome to Express.js Server!",
  "status": "running",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

#### GET `/health`
Health check endpoint.

**Response:**
```json
{
  "status": "healthy"
}
```

### Traits Endpoints

#### GET `/api/traits`
Get all traits.

**Response:**
```json
{
  "success": true,
  "count": 5,
  "data": [
    {
      "_id": "62822026793707eaf32b23fb",
      "gcsFileName": "Niche (Prompted).h5",
      "contextPromptEnabled": true,
      "initialReactionEnabled": false,
      "title": "Niche (Prompted)",
      "color": "fixable",
      "traitType": "primary"
    }
  ]
}
```

#### GET `/api/traits/context-prompt`
Get traits with context prompt enabled.

**Response:**
```json
{
  "success": true,
  "count": 1,
  "data": [...]
}
```

#### GET `/api/traits/initial-reaction`
Get traits with initial reaction enabled.

**Response:**
```json
{
  "success": true,
  "count": 4,
  "data": [...]
}
```

#### POST `/api/traits/process`
Process traits and queue tasks to Google Cloud Tasks for ML processing.

**Request Body:** (optional, uses default data if not provided)
```json
{
  "projectId": "691f0de3cde91b17bbb84746"
}
```

**Response:**
```json
{
  "success": true,
  "projectId": "691f0de3cde91b17bbb84746",
  "queuedTasks": {
    "contextPromptTasks": [
      {
        "traitId": "62822026793707eaf32b23fb",
        "traitTitle": "Niche (Prompted)",
        "gcsFileName": "Niche (Prompted).h5",
        "taskType": "CONTEXT_PROMPT",
        "status": "queued",
        "taskName": "projects/.../tasks/...",
        "timestamp": "2024-01-01T00:00:00.000Z"
      }
    ],
    "initialReactionTasks": [...]
  },
  "summary": {
    "contextPromptTasksQueued": 1,
    "initialReactionTasksQueued": 4,
    "totalTasksQueued": 5
  }
}
```

### Reactions Endpoints

#### GET `/api/reactions/initial`
Get initial reaction data.

**Response:**
```json
{
  "success": true,
  "count": 150,
  "data": ["reaction text 1", "reaction text 2", ...]
}
```

#### GET `/api/reactions/context`
Get context prompt data.

**Response:**
```json
{
  "success": true,
  "count": 150,
  "data": ["context prompt 1", "context prompt 2", ...]
}
```

### Callback Endpoints

#### POST `/trait-prediction`
Callback endpoint for ML trait prediction results from Google Cloud Functions.

**Request Body:**
```json
{
  "data": [...],
  "model_filename": "Niche (Prompted).h5",
  "project_id": "691f0de3cde91b17bbb84746",
  "type": "CONTEXT_PROMPT"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Trait prediction callback received",
  "receivedData": {
    "dataCount": 150,
    "model_filename": "Niche (Prompted).h5",
    "project_id": "691f0de3cde91b17bbb84746",
    "type": "CONTEXT_PROMPT"
  }
}
```

**Console Output:**
```
=== Trait Prediction Callback ===
Data: [...]
Model Filename: Niche (Prompted).h5
Project ID: 691f0de3cde91b17bbb84746
Type: CONTEXT_PROMPT
================================
```

## Architecture

### Files Structure

```
.
├── server.js           # Main Express server
├── traits.js           # Traits data
├── reaction.js         # Reactions and context prompts data
├── gcloudService.js    # Google Cloud Tasks service
├── package.json        # Dependencies
├── .env               # Environment variables
└── README.md          # Documentation
```

### Data Flow

1. **POST `/api/traits/process`** receives a request to process traits
2. Server prepares data from `contextPrompts` and `initialReactions`
3. For each trait with enabled flags:
   - Context prompt enabled traits → queue `CONTEXT_PROMPT` tasks
   - Initial reaction enabled traits → queue `INITIAL_REACTION` tasks
4. Tasks are queued to Google Cloud Tasks
5. Google Cloud Tasks triggers ML processing via Cloud Functions
6. ML results are sent back to **POST `/trait-prediction`** callback

### Google Cloud Integration

The server integrates with Google Cloud Tasks to queue ML processing jobs:

- **Cloud Tasks Queue:** Manages task execution
- **Cloud Functions:** Processes ML predictions
- **Service Account:** Authenticates requests
- **OIDC Token:** Secures communication

## Error Handling

All endpoints include error handling:
- 400: Bad Request
- 404: Route Not Found
- 500: Internal Server Error

Errors are logged to console and returned as JSON:
```json
{
  "success": false,
  "error": "Error message"
}
```

## Development

### Available Scripts

- `npm start` - Start the server
- `npm run dev` - Start with nodemon (auto-reload)

### Adding New Traits

Edit `traits.js` to add new trait configurations:
```javascript
{
  "_id": "unique-id",
  "gcsFileName": "Model.h5",
  "contextPromptEnabled": true,
  "initialReactionEnabled": true,
  "title": "Trait Name",
  "color": "positive|negative|neutral|fixable",
  "traitType": "primary"
}
```

## Security Notes

- Never commit `.env` file to version control
- Keep Google Cloud service account credentials secure
- Use proper IAM roles and permissions
- Enable HTTPS in production
- Implement rate limiting for production use

## License

ISC
