const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const films = [...document.querySelectorAll('.film')];
const observer = new IntersectionObserver(entries => {
  for (const { target, isIntersecting } of entries) {
    const video = target.querySelector('video');
    if (!isIntersecting) video.pause();
    else if (!reducedMotion.matches && !target.dataset.userPaused) play(video);
  }
}, { threshold: 0.35 });
function play(video) {
  video.play().catch(error => {
    video.controls = true;
    const button = video.closest('.film').querySelector('.film-toggle');
    button.textContent = 'Play ↗';
    console.info('Video playback requires interaction:', error.message);
  });
}
for (const film of films) {
  const video = film.querySelector('video');
  const toggle = film.querySelector('.film-toggle');
  toggle.addEventListener('click', () => {
    if (video.paused) { delete film.dataset.userPaused; play(video); }
    else { film.dataset.userPaused = 'true'; video.pause(); }
  });
  video.addEventListener('play', () => { toggle.textContent = 'Pause Ⅱ'; toggle.setAttribute('aria-label', 'Pause demonstration'); });
  video.addEventListener('pause', () => { toggle.textContent = 'Play ↗'; toggle.setAttribute('aria-label', 'Play demonstration'); });
  video.addEventListener('error', () => {
    toggle.textContent = 'Video unavailable'; toggle.disabled = true; video.controls = true;
    console.error('Demonstration video failed to load:', video.currentSrc, video.error);
  });
  observer.observe(film);
}
reducedMotion.addEventListener('change', () => {
  if (reducedMotion.matches) films.forEach(film => film.querySelector('video').pause());
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) films.forEach(film => film.querySelector('video').pause());
  else films.forEach(film => { observer.unobserve(film); observer.observe(film); });
});

document.querySelectorAll('[data-jump]').forEach(button => button.addEventListener('click', () => {
  const reel = button.closest('[data-reel]'), video = reel.querySelector('video');
  const seek = () => { video.currentTime = Number(button.dataset.jump); video.play().catch(error => { video.controls = true; console.info(error.message); }); };
  if (video.readyState) seek(); else video.addEventListener('loadedmetadata', seek, {once:true});
  reel.querySelectorAll('[data-jump]').forEach(other => { other.classList.toggle('is-active', other === button); other.setAttribute('aria-pressed', String(other === button)); });
}));
