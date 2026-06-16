// Vercel Serverless Function: re-fetches Strava data for all connected athletes
// This uses refresh tokens stored in Vercel KV to get updated activity data
// including Walk/Hike activities that may not have been captured before.
//
// Call: GET /api/refresh?secret=YOUR_SECRET
// (protects the endpoint from being called by anyone)

export default async function handler(req, res) {
  // Simple secret protection
  const { secret } = req.query;
  if (secret !== process.env.REFRESH_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const kvUrl = process.env.VERCEL_KV_REST_API_URL;
  const kvToken = process.env.VERCEL_KV_REST_API_TOKEN;
  const githubToken = process.env.GITHUB_TOKEN;

  if (!kvUrl || !kvToken) {
    return res.status(500).json({ error: 'KV not configured' });
  }

  const results = [];
  const errors = [];

  try {
    // Get all stored token keys from KV
    const keysResponse = await fetch(`${kvUrl}/keys/token:*`, {
      headers: { Authorization: `Bearer ${kvToken}` },
    });

    if (!keysResponse.ok) {
      return res.status(500).json({ error: 'Failed to list KV keys' });
    }

    const keysData = await keysResponse.json();
    const keys = keysData.result || [];

    if (keys.length === 0) {
      return res.json({ message: 'No stored tokens found', results: [] });
    }

    // Process each athlete
    for (const key of keys) {
      const participantName = decodeURIComponent(key.replace('token:', ''));

      try {
        // Get stored token
        const tokenResp = await fetch(`${kvUrl}/get/${key}`, {
          headers: { Authorization: `Bearer ${kvToken}` },
        });

        if (!tokenResp.ok) continue;

        const tokenRaw = await tokenResp.json();
        let tokenInfo = tokenRaw.result;

        // Parse if string
        if (typeof tokenInfo === 'string') {
          tokenInfo = JSON.parse(tokenInfo);
        }

        if (!tokenInfo || !tokenInfo.refresh_token) {
          errors.push({ name: participantName, error: 'No refresh token' });
          continue;
        }

        // Refresh the access token
        const refreshResp = await fetch('https://www.strava.com/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: process.env.STRAVA_CLIENT_ID,
            client_secret: process.env.STRAVA_CLIENT_SECRET,
            refresh_token: tokenInfo.refresh_token,
            grant_type: 'refresh_token',
          }),
        });

        if (!refreshResp.ok) {
          const errText = await refreshResp.text();
          errors.push({ name: participantName, error: `Token refresh failed: ${errText}` });
          continue;
        }

        const newTokenData = await refreshResp.json();
        const accessToken = newTokenData.access_token;

        // Update stored token in KV
        await fetch(`${kvUrl}/set/${key}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${kvToken}` },
          body: JSON.stringify({
            access_token: newTokenData.access_token,
            refresh_token: newTokenData.refresh_token,
            expires_at: newTokenData.expires_at,
            athlete_id: tokenInfo.athlete_id,
          }),
        });

        // Fetch June 2026 activities
        const afterEpoch = Math.floor(new Date('2026-06-01T00:00:00Z').getTime() / 1000);
        const beforeEpoch = Math.floor(new Date('2026-06-30T23:59:59Z').getTime() / 1000);

        let allActivities = [];
        let page = 1;

        while (true) {
          const actResponse = await fetch(
            `https://www.strava.com/api/v3/athlete/activities?after=${afterEpoch}&before=${beforeEpoch}&page=${page}&per_page=100`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );

          if (!actResponse.ok) break;

          const activities = await actResponse.json();
          if (!activities.length) break;

          allActivities = allActivities.concat(activities);
          page++;
        }

        // Calculate distances (including Walk/Hike)
        let runDistance = 0;
        let rideDistance = 0;
        let walkDistance = 0;
        let totalActivities = 0;

        for (const activity of allActivities) {
          const type = activity.type || '';
          const distKm = (activity.distance || 0) / 1000;

          if (type === 'Run' || type === 'VirtualRun') {
            runDistance += distKm;
            totalActivities++;
          } else if (type === 'Ride' || type === 'VirtualRide') {
            rideDistance += distKm;
            totalActivities++;
          } else if (type === 'Walk' || type === 'Hike') {
            walkDistance += distKm;
            totalActivities++;
          }
        }

        const totalDistance = runDistance + rideDistance + walkDistance;

        const participantData = {
          distanceCovered: Math.round(totalDistance * 100) / 100,
          runDistance: Math.round((runDistance + walkDistance) * 100) / 100,
          walkDistance: Math.round(walkDistance * 100) / 100,
          rideDistance: Math.round(rideDistance * 100) / 100,
          activities: totalActivities,
        };

        // Update GitHub data.json
        if (githubToken) {
          await updateGitHubData(githubToken, participantName, participantData);
        }

        results.push({
          name: participantName,
          ...participantData,
          rawRun: Math.round(runDistance * 100) / 100,
        });

      } catch (err) {
        errors.push({ name: participantName, error: err.message });
      }
    }

    return res.json({
      message: `Refreshed ${results.length} athletes`,
      results,
      errors,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}


async function updateGitHubData(token, participantName, newData) {
  const owner = 'Aryanil';
  const repo = 'fitribe-challenge';
  const path = 'data.json';

  try {
    const getResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'fitribe-bot' } }
    );

    if (!getResponse.ok) return;

    const fileInfo = await getResponse.json();
    const content = JSON.parse(Buffer.from(fileInfo.content, 'base64').toString());

    const entry = content.find(e => e.name === participantName);
    if (entry) {
      entry.distanceCovered = newData.distanceCovered;
      entry.runDistance = newData.runDistance;
      entry.walkDistance = newData.walkDistance || 0;
      entry.rideDistance = newData.rideDistance;
      entry.activities = newData.activities;
    }

    await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'fitribe-bot',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: `Refresh ${participantName} - ${newData.distanceCovered} km (walk: ${newData.walkDistance} km)`,
          content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
          sha: fileInfo.sha,
        }),
      }
    );
  } catch (e) {
    console.error('GitHub update error:', e);
  }
}
