import assert from 'node:assert/strict';
import test from 'node:test';

import utils from '../src/utils.js';

const makeRelease = ({
  tag,
  prerelease = false,
  draft = false,
  publishedAt = '2026-01-01T00:00:00Z',
}) => ({
  tag_name: tag,
  prerelease,
  draft,
  published_at: publishedAt,
  created_at: publishedAt,
  html_url: `https://example.com/releases/${tag}`,
  body: `${tag} changelog`,
});

test('fetchLatestVersion picks newest unstable prerelease even when API order is not semver-sorted', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify([
    makeRelease({ tag: 'v2.1.6-alpha.9', prerelease: true, publishedAt: '2026-02-13T04:40:11Z' }),
    makeRelease({ tag: 'v2.1.6-alpha.8', prerelease: true, publishedAt: '2026-02-13T04:30:39Z' }),
    makeRelease({ tag: 'v2.1.6-beta.2', prerelease: true, publishedAt: '2026-02-13T05:07:23Z' }),
    makeRelease({ tag: 'v2.1.5', prerelease: false, publishedAt: '2026-02-06T10:05:27Z' }),
  ]), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  try {
    const result = await utils.updater.fetchLatestVersion('unstable');
    assert.equal(result?.version, 'v2.1.6-beta.2');
    assert.equal(result?.channel, 'unstable');
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchLatestVersion picks newest stable release for stable channel', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify([
    makeRelease({ tag: 'v2.1.8', prerelease: false, publishedAt: '2026-02-10T10:00:00Z' }),
    makeRelease({ tag: 'v2.1.11-alpha.1', prerelease: true, publishedAt: '2026-02-12T10:00:00Z' }),
    makeRelease({ tag: 'v2.1.10', prerelease: false, publishedAt: '2026-02-11T10:00:00Z' }),
    makeRelease({ tag: 'v2.1.9', prerelease: false, publishedAt: '2026-02-09T10:00:00Z' }),
  ]), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  try {
    const result = await utils.updater.fetchLatestVersion('stable');
    assert.equal(result?.version, 'v2.1.10');
    assert.equal(result?.channel, 'stable');
  } finally {
    global.fetch = originalFetch;
  }
});
