import assets from "./assets.mjs";

const CHANNEL_ID = "UC5jVy72lE4BWCkNavcC9k5Q";
const json = (data, status = 200, maxAge = 900) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": `private, max-age=${maxAge}` },
});
const contentTypes = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", json: "application/json; charset=utf-8" };

function decode(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function accessToken(env) {
  const body = new URLSearchParams({
    client_id: env.YOUTUBE_CLIENT_ID,
    client_secret: env.YOUTUBE_CLIENT_SECRET,
    refresh_token: env.YOUTUBE_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const payload = await response.json();
  if (!response.ok || !payload.access_token) throw new Error(`YouTube authorization failed: ${payload.error || response.status}`);
  return payload.access_token;
}

async function google(token, url) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `YouTube API ${response.status}`);
  return payload;
}

async function googleRequest(token, url, options = {}) {
  const response = await fetch(url, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `Google API ${response.status}`);
  return payload;
}

async function channel(token) {
  const data = await google(token, "https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails,statistics&mine=true");
  const item = data.items?.[0];
  if (!item || item.id !== CHANNEL_ID) throw new Error("Authorized account does not own the configured YouTube channel");
  return item;
}

async function uploads(token) {
  const owner = await channel(token);
  const playlistId = owner.contentDetails.relatedPlaylists.uploads;
  const ids = [];
  let pageToken = "";
  do {
    const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
    url.search = new URLSearchParams({ part: "contentDetails", playlistId, maxResults: "50", ...(pageToken ? { pageToken } : {}) });
    const page = await google(token, url);
    ids.push(...(page.items || []).map(item => item.contentDetails.videoId));
    pageToken = page.nextPageToken || "";
  } while (pageToken);
  const videos = [];
  for (let index = 0; index < ids.length; index += 50) {
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.search = new URLSearchParams({ part: "snippet,contentDetails,statistics,status", id: ids.slice(index, index + 50).join(",") });
    const page = await google(token, url);
    videos.push(...(page.items || []));
  }
  videos.sort((a, b) => new Date(b.snippet.publishedAt) - new Date(a.snippet.publishedAt));
  return { owner, videos };
}

function videoShape(video) {
  return {
    videoId: video.id,
    title: video.snippet.title,
    publishedAt: video.snippet.publishedAt,
    thumbnail: video.snippet.thumbnails?.maxres?.url || video.snippet.thumbnails?.high?.url || video.snippet.thumbnails?.medium?.url,
    duration: video.contentDetails.duration,
    viewCount: Number(video.statistics?.viewCount || 0),
    likeCount: Number(video.statistics?.likeCount || 0),
    commentCount: Number(video.statistics?.commentCount || 0),
    privacyStatus: video.status?.privacyStatus || "unknown",
    publishAt: video.status?.publishAt || null,
  };
}

const dateOnly = date => date.toISOString().slice(0, 10);
function daysAgo(days) { const date = new Date(); date.setUTCDate(date.getUTCDate() - days); return dateOnly(date); }

async function analytics(token, metrics, dimensions, extra = {}) {
  const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
  url.search = new URLSearchParams({ ids: "channel==MINE", startDate: daysAgo(365), endDate: dateOnly(new Date()), metrics, ...(dimensions ? { dimensions } : {}), ...extra });
  return google(token, url);
}

const safeAnalytics = (token, metrics, dimensions, extra) => analytics(token, metrics, dimensions, extra).catch(() => ({ columnHeaders: [], rows: [] }));
function reportObjects(report) {
  const names = (report.columnHeaders || []).map(column => column.name);
  return (report.rows || []).map(row => Object.fromEntries(names.map((name, index) => [name, row[index]])));
}

function parseCsvLine(line) {
  const values = []; let value = "", quoted = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '"' && quoted && line[index + 1] === '"') { value += '"'; index++; }
    else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) { values.push(value); value = ""; }
    else value += character;
  }
  values.push(value); return values;
}

function csvObjects(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => Object.fromEntries(parseCsvLine(line).map((value, index) => [headers[index], value])));
}

async function reachReportData(token, videoId) {
  const root = "https://youtubereporting.googleapis.com/v1";
  const jobs = await googleRequest(token, `${root}/jobs?includeSystemManaged=false`);
  let job = (jobs.jobs || []).find(item => item.reportTypeId === "channel_reach_basic_a1");
  if (!job) {
    job = await googleRequest(token, `${root}/jobs`, { method: "POST", body: JSON.stringify({ reportTypeId: "channel_reach_basic_a1", name: "Adhyesha Studio thumbnail reach" }) });
    return { available: false, status: "collecting", message: "Thumbnail reach collection has started. YouTube will add the first verified report after processing." };
  }
  const listing = await googleRequest(token, `${root}/jobs/${encodeURIComponent(job.id)}/reports?pageSize=30`);
  const reports = (listing.reports || []).sort((a, b) => new Date(b.endTime) - new Date(a.endTime)).slice(0, 28);
  if (!reports.length) return { available: false, status: "collecting", message: "YouTube is preparing the first thumbnail reach report." };
  const reportRows = await Promise.all(reports.map(async report => {
    const response = await fetch(report.downloadUrl, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) return [];
    return csvObjects(await response.text()).filter(row => row.video_id === videoId);
  }));
  const rows = reportRows.flat();
  const impressions = rows.reduce((total, row) => total + Number(row.video_thumbnail_impressions || 0), 0);
  const weightedClicks = rows.reduce((total, row) => {
    const rowImpressions = Number(row.video_thumbnail_impressions || 0);
    const rawCtr = Number(row.video_thumbnail_impressions_ctr || 0);
    const ctrRatio = rawCtr > 1 ? rawCtr / 100 : rawCtr;
    return total + rowImpressions * ctrRatio;
  }, 0);
  return { available: true, status: "ready", impressions, ctrPercent: impressions ? weightedClicks * 100 / impressions : 0, estimatedClicks: Math.round(weightedClicks), days: new Set(rows.map(row => row.date)).size, latestReportAt: reports[0].endTime };
}

async function videoAnalytics(token, videoId) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || "")) throw new Error("Invalid video ID");
  const detailsUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
  detailsUrl.search = new URLSearchParams({ part: "snippet,contentDetails,statistics,status", id: videoId });
  const filter = { filters: `video==${videoId}` };
  const [details, summaryReport, dailyReport, trafficReport, deviceReport, countryReport, subscribedReport, demographicsReport, retentionReport, cardsReport, endScreenReport, reach] = await Promise.all([
    google(token, detailsUrl),
    safeAnalytics(token, "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,shares,subscribersGained,subscribersLost", "", filter),
    safeAnalytics(token, "views,estimatedMinutesWatched,averageViewDuration", "day", { ...filter, sort: "day" }),
    safeAnalytics(token, "views,estimatedMinutesWatched", "insightTrafficSourceType", { ...filter, sort: "-views" }),
    safeAnalytics(token, "views,estimatedMinutesWatched", "deviceType", { ...filter, sort: "-views" }),
    safeAnalytics(token, "views,estimatedMinutesWatched", "country", { ...filter, sort: "-views", maxResults: "10" }),
    safeAnalytics(token, "views,estimatedMinutesWatched", "subscribedStatus", { ...filter, sort: "-views" }),
    safeAnalytics(token, "viewerPercentage", "ageGroup,gender", { ...filter, sort: "-viewerPercentage" }),
    safeAnalytics(token, "audienceWatchRatio,relativeRetentionPerformance", "elapsedVideoTimeRatio", { ...filter, sort: "elapsedVideoTimeRatio" }),
    safeAnalytics(token, "cardImpressions,cardClicks,cardClickRate,cardTeaserImpressions,cardTeaserClicks,cardTeaserClickRate", "", filter),
    safeAnalytics(token, "endScreenElementImpressions,endScreenElementClicks,endScreenElementClickRate", "", filter),
    reachReportData(token, videoId).catch(error => ({ available: false, status: "setup_required", message: error.message.includes("has not been used") || error.message.includes("disabled") ? "Enable YouTube Reporting API in the connected Google Cloud project to load thumbnail impressions and CTR." : "Thumbnail reach data is temporarily unavailable." })),
  ]);
  const video = details.items?.[0];
  if (!video || video.snippet?.channelId !== CHANNEL_ID) throw new Error("Video is not part of the authorized channel");
  const summary = reportObjects(summaryReport)[0] || {};
  return {
    video: videoShape(video), summary,
    daily: reportObjects(dailyReport).filter(row => Number(row.views || 0) > 0), traffic: reportObjects(trafficReport), devices: reportObjects(deviceReport),
    countries: reportObjects(countryReport), subscribed: reportObjects(subscribedReport), demographics: reportObjects(demographicsReport),
    retention: reportObjects(retentionReport), cards: reportObjects(cardsReport)[0] || {}, endScreens: reportObjects(endScreenReport)[0] || {}, reach, syncedAt: new Date().toISOString(),
  };
}

async function dashboardData(token) {
  const [{ owner, videos: allVideos }, dailyReport, videoReport, trafficReport] = await Promise.all([
    uploads(token),
    analytics(token, "views,estimatedMinutesWatched,subscribersGained,subscribersLost", "day", { sort: "day" }),
    analytics(token, "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage", "video", { sort: "-views", maxResults: "200" }),
    analytics(token, "views,estimatedMinutesWatched", "insightTrafficSourceType", { startDate: daysAgo(28), sort: "-views" }).catch(() => ({ rows: [] })),
  ]);
  const videos = allVideos.filter(video => video.status?.privacyStatus === "public");
  const analyticsByVideo = new Map((videoReport.rows || []).map(row => [row[0], {
    watch: Number(row[2]), duration: Number(row[3]), percent: Number(row[4]),
  }]));
  const daily = (dailyReport.rows || []).map(row => [row[0], Number(row[1]), Number(row[2]), Number(row[3]), Number(row[4])]);
  const latest = videos.map(video => {
    const item = videoShape(video);
    const performance = analyticsByVideo.get(video.id) || { watch: 0, duration: 0, percent: 0 };
    return {
      id: video.id, title: item.title,
      date: new Date(item.publishedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }),
      thumb: item.thumbnail, views: item.viewCount, likes: item.likeCount, comments: item.commentCount,
      watch: performance.watch, duration: performance.duration, percent: performance.percent,
    };
  });
  const popular = [...latest].sort((a, b) => b.views - a.views).slice(0, 4).map(video => video.id);
  const trafficRows = (trafficReport.rows || []).map(row => ({ source: row[0], views: Number(row[1] || 0), watchMinutes: Number(row[2] || 0) }));
  const trafficTotal = trafficRows.reduce((sum, row) => sum + row.views, 0);
  const traffic = trafficRows.map(row => ({ ...row, percent: trafficTotal ? row.views * 100 / trafficTotal : 0 }));
  return {
    channel: {
      viewCount: Number(owner.statistics?.viewCount || 0),
      subscriberCount: Number(owner.statistics?.subscriberCount || 0),
      videoCount: Number(owner.statistics?.videoCount || videos.length),
    },
    daily, videos: latest, popular, traffic, syncedAt: new Date().toISOString(),
  };
}

async function currentSuggestions(token) {
  const publishedAfter = new Date(Date.now() - 30 * 86400000).toISOString();
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.search = new URLSearchParams({ part: "snippet", q: "Hindi nursery rhymes Hindi kids songs", type: "video", order: "viewCount", regionCode: "IN", publishedAfter, maxResults: "25" });
  const search = await google(token, url);
  const ids = (search.items || []).map(item => item.id.videoId).filter(Boolean);
  if (!ids.length) return [];
  const detailsUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
  detailsUrl.search = new URLSearchParams({ part: "snippet,statistics", id: ids.join(",") });
  const details = await google(token, detailsUrl);
  const rows = (details.items || []).map(video => {
    const views = Number(video.statistics?.viewCount || 0);
    const ageHours = Math.max(1, (Date.now() - new Date(video.snippet.publishedAt)) / 3600000);
    return { video, views, vph: views / ageHours };
  });
  const median = [...rows].map(row => row.vph).sort((a, b) => a - b)[Math.floor(rows.length / 2)] || 1;
  return rows.map(({ video, views, vph }) => ({
    id: video.id, title: video.snippet.title, channel: video.snippet.channelTitle,
    thumb: video.snippet.thumbnails?.high?.url || video.snippet.thumbnails?.medium?.url,
    views, vph, momentum: Math.max(0.1, vph / median),
  })).sort((a, b) => b.vph - a.vph).slice(0, 12);
}

async function liveJson(request, env, pathname) {
  const token = await accessToken(env);
  let response;
  if (pathname === "/channel.json") {
    const owner = await channel(token);
    response = json({
      viewCount: Number(owner.statistics?.viewCount || 0),
      subscriberCount: Number(owner.statistics?.subscriberCount || 0),
      videoCount: Number(owner.statistics?.videoCount || 0),
      syncedAt: new Date().toISOString(),
    }, 200, 1200);
  } else if (pathname === "/content.json") {
    const data = await uploads(token);
    response = json({ channel: { id: data.owner.id, title: data.owner.snippet.title, statistics: data.owner.statistics }, videos: data.videos.filter(video => video.status?.privacyStatus === "public").map(videoShape), syncedAt: new Date().toISOString() });
  } else if (pathname === "/scheduled.json") {
    const data = await uploads(token);
    const now = Date.now();
    const scheduled = data.videos.filter(video => video.status?.privacyStatus === "private" && video.status?.publishAt && new Date(video.status.publishAt).getTime() > now).map(videoShape).sort((a, b) => new Date(a.publishAt) - new Date(b.publishAt));
    response = json({ videos: scheduled, syncedAt: new Date().toISOString() }, 200, 1200);
  } else if (pathname === "/data.json") {
    response = json(await dashboardData(token));
  } else if (pathname === "/video.json") {
    response = json(await videoAnalytics(token, new URL(request.url).searchParams.get("id")), 200, 1200);
  } else {
    response = json({ videos: await currentSuggestions(token), syncedAt: new Date().toISOString() }, 200, 1200);
  }
  return response;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (["/channel.json", "/data.json", "/content.json", "/scheduled.json", "/suggestions.json", "/video.json"].includes(url.pathname)) return await liveJson(request, env, url.pathname);
      const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
      const encoded = assets[pathname] || (pathname.endsWith("/") ? assets[`${pathname}index.html`] : null);
      if (!encoded) return new Response("Not found", { status: 404 });
      const extension = pathname.split(".").pop();
      return new Response(decode(encoded), { headers: { "content-type": contentTypes[extension] || "application/octet-stream", "cache-control": "no-cache" } });
    } catch (error) {
      console.error(error);
      return json({ error: "Live YouTube data is temporarily unavailable. Please try again shortly." }, 503, 0);
    }
  },
};
