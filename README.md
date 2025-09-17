# Click Race Game

A simple realtime click race game built with Express and WebSockets. Players set a name, wait for a race and click as fast as possible during a 10 second window. A new race starts 30 seconds after the first player joins the lobby, and a live leaderboard is shared by all participants.

## Features

- Realtime lobby showing attendees for the next race
- Automatic race start 30 seconds after the first player joins
- Profanity-filtered nicknames
- Scores stored in DynamoDB

## Create DynamoDB Table
- Table Name: `ClickRaceData`
    - PK: `resultId`
    - SK: `score`

## Running

```bash
# install dependencies
npm install

# run the server (expects AWS credentials with DynamoDB access)
node express.mjs
```

Environment variables:

- `AWS_REGION` – AWS region of DynamoDB (default `us-east-1`)
- `DDB_TABLE` – table used to store race results and leaderboard cache (`ClickRaceData` by default)
- `RACE_DURATION_SECONDS` – duration of the click phase (default 10)
- `ADMIN_TOKEN` – shared secret required by `/api/ban/:id` cockpit actions

Open `http://localhost` in multiple browsers to play.
