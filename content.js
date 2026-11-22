const timer = setInterval(() => {
  if (!chrome.runtime?.id) {
    clearInterval(timer);
    return;
  }
  const video = document.querySelector('video.html5-main-video');
  const videoId = new URLSearchParams(location.search).get('v');
  if (!video || !videoId || document.hidden) return;
  try {
    chrome.runtime.sendMessage({ type: 'time', videoId, time: video.currentTime }).catch(() => {});
  } catch {
    clearInterval(timer);
  }
}, 500);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'seek') {
    const video = document.querySelector('video.html5-main-video');
    if (video) video.currentTime = msg.time;
  }
});
