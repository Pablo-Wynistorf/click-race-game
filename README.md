# Click Race Game

A simple realtime click race game built with Express and WebSockets. Players set a name, wait for a race and click as fast as possible during a 10 second window. A new race starts 30 seconds after the first player joins the lobby, and a live leaderboard is shared by all participants.

## Features

- Realtime lobby showing attendees for the next race
- Automatic race start 30 seconds after the first player joins
- Profanity-filtered nicknames
- Scores stored in DynamoDB

## Running

```bash
# install dependencies
npm install

# run the server (expects AWS credentials with DynamoDB access)
PORT=3000 node server.js
```

Environment variables:

- `AWS_REGION` – AWS region of DynamoDB (default `us-east-1`)
- `DDB_TABLE_SCORES` – table for scores (`ClickRaceScores` by default)
- `DDB_TABLE_EVENTS` – table for events (`ClickRaceEvents` by default)
- `RACE_DURATION_SECONDS` – duration of the click phase (default 10)

Open `http://localhost:3000` in multiple browsers to play.
