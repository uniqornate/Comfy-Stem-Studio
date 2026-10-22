// Follower for the main window's transport. The video is muted; sound is played by the main window.
const video = document.getElementById('picture');
let latest = null;
function follow(state) {
  if (!state) return;
  latest = state; video.playbackRate = state.rate || 1;
  const drift = Math.abs(video.currentTime - state.position);
  if (!state.playing) { if (!video.paused) video.pause(); if (drift > 0.03) video.currentTime = state.position; return; }
  if (drift > 0.3 || video.paused) video.currentTime = state.position;
  if (video.paused) void video.play().catch(() => {});
}
window.preview.onInit(({ url, state }) => {
  if (url && video.getAttribute('src') !== url) { video.src = url; video.addEventListener('loadedmetadata', () => follow(latest), { once: true }); }
  follow(state);
});
window.preview.onState(follow);
window.addEventListener('keydown', event => { if (event.key === 'Escape') window.preview.close(); });
window.addEventListener('dblclick', () => window.preview.close());
window.preview.ready();
