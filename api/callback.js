// Vercel Serverless Function: handles Strava OAuth callback
// When a participant clicks "Authorize" on Strava, they get redirected here.
// This function automatically exchanges the code for a token and fetches their data.

export default async function handler(req, res) {
  const { code, state, error } = req.query;

  // If user denied authorization
  if (error) {
    return res.redirect('/denied.html');
  }

  if (!code || !state) {
    return res.redirect('/error.html');
  }

  const participantName = decodeURIComponent(state);

  try {
    // Exchange the code for an access token
    const tokenResponse = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code: code,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenResponse.ok) {
      const err = await tokenResponse.text();
      console.error('Token exchange failed:', err);
      return res.redirect(`/error.html?reason=token_failed`);
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;
    const athleteId = tokenData.athlete?.id;
    const athleteName = `${tokenData.athlete?.firstname || ''} ${tokenData.athlete?.lastname || ''}`.trim();

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

    // Calculate distances
    let runDistance = 0;
    let rideDistance = 0;
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
      }
    }

    const totalDistance = runDistance + rideDistance;

    // Store the data using Vercel KV (or a JSON blob store)
    // For simplicity, we'll use the Vercel Blob store or write to a GitHub file
    // For now, store in Vercel KV if available, otherwise log and redirect with data

    // Try to update data.json via GitHub API
    const githubToken = process.env.GITHUB_TOKEN;
    if (githubToken) {
      await updateGitHubData(githubToken, participantName, {
        distanceCovered: Math.round(totalDistance * 100) / 100,
        runDistance: Math.round(runDistance * 100) / 100,
        rideDistance: Math.round(rideDistance * 100) / 100,
        activities: totalActivities,
      });
    }

    // Also store the refresh token for future updates
    if (process.env.VERCEL_KV_REST_API_URL) {
      try {
        const kvUrl = process.env.VERCEL_KV_REST_API_URL;
        const kvToken = process.env.VERCEL_KV_REST_API_TOKEN;
        await fetch(`${kvUrl}/set/token:${encodeURIComponent(participantName)}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${kvToken}` },
          body: JSON.stringify({
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            expires_at: tokenData.expires_at,
            athlete_id: athleteId,
          }),
        });
      } catch (e) {
        console.error('KV store error:', e);
      }
    }

    // Redirect to success page
    const params = new URLSearchParams({
      name: participantName,
      athlete: athleteName,
      run: runDistance.toFixed(1),
      ride: rideDistance.toFixed(1),
      total: totalDistance.toFixed(1),
      activities: totalActivities.toString(),
    });

    return res.redirect(`/success.html?${params.toString()}`);

  } catch (err) {
    console.error('Callback error:', err);
    return res.redirect(`/error.html?reason=server_error`);
  }
}


async function updateGitHubData(token, participantName, newData) {
  const owner = 'Aryanil';
  const repo = 'fitribe-challenge';
  const path = 'data.json';

  try {
    // Get current file
    const getResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'fitribe-bot' } }
    );

    if (!getResponse.ok) return;

    const fileInfo = await getResponse.json();
    const content = JSON.parse(Buffer.from(fileInfo.content, 'base64').toString());

    // Update participant data
    const entry = content.find(e => e.name === participantName);
    if (entry) {
      entry.distanceCovered = newData.distanceCovered;
      entry.runDistance = newData.runDistance;
      entry.rideDistance = newData.rideDistance;
      entry.activities = newData.activities;
    }

    // Commit update
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
          message: `Update ${participantName} - ${newData.distanceCovered} km`,
          content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
          sha: fileInfo.sha,
        }),
      }
    );
  } catch (e) {
    console.error('GitHub update error:', e);
  }
}
