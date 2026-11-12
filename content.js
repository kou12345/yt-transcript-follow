setInterval(() => {
  const video = document.querySelector('video.html5-main-video');
  const videoId = new URLSearchParams(location.search).get('v');
  if (!video || !videoId || document.hidden) return;
  chrome.runtime.sendMessage({ type: 'time', videoId, time: video.currentTime }).catch(() => {});
}, 500);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'seek') document.querySelector('video.html5-main-video').currentTime = msg.time;
});
