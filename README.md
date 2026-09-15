# Adhyesha Rhymes Channel Monitor

A YouTube Studio-style analytics dashboard for the Adhyesha Rhymes channel. It uses the YouTube Data API, YouTube Analytics API and YouTube Reporting API—no vidIQ dependency.

## Features

- Live channel totals and 28/90/365-day analytics
- All uploaded and scheduled videos
- Popular-video rankings
- Per-video Overview, Reach, Engagement and Audience tabs
- Thumbnail impressions, CTR and calculated thumbnail clicks
- Traffic sources, devices, countries and audience retention
- Video suggestions, advanced reports and content planner
- Automatic browser refresh every 20 minutes
- Responsive YouTube Studio-style interface

## Local build

```bash
npm run build
```

The build embeds the static dashboard files into the Worker bundle at `dist/server/assets.mjs`.

## Required environment variables

Copy `.env.example` to `.env` and provide:

- `YOUTUBE_CLIENT_ID`
- `YOUTUBE_CLIENT_SECRET`
- `YOUTUBE_REFRESH_TOKEN`

Never commit the real values. The Google OAuth client must allow the deployed callback URL and request `youtube.readonly` and `yt-analytics.readonly` scopes.

## APIs

Enable these APIs in the connected Google Cloud project:

- YouTube Data API v3
- YouTube Analytics API
- YouTube Reporting API

