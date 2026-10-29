import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Recommender } from '../server/recommend.js';

const TRACK = { id: 't1', artist_id: 'a1', genre: 'Ambient', language: 'en', tempo: 90, key: 0, mode: 1, energy: 0.5, valence: 0.5, danceability: 0.5, acousticness: 0.5 };

test('a retrain asked for mid-run runs again afterwards, so it sees the newest streams', async () => {
  let loads = 0;
  const store = {
    async all(sql) {
      if (!sql.includes('FROM tracks')) return [];
      loads++;
      return [TRACK];
    },
  };
  const rec = new Recommender(store);
  const first = rec.train();
  assert.equal(rec.train(), first, 'plain callers share the run in progress');
  const fresh = rec.train({ fresh: true });
  assert.notEqual(fresh, first);
  assert.equal(rec.train({ fresh: true }), fresh, 'fresh callers share the follow-up run');
  await fresh;
  assert.equal(loads, 2, 'the data was loaded again after the first run');
  await rec.train({ fresh: true });
  assert.equal(loads, 3, 'with nothing in progress, a fresh retrain just trains');
});
