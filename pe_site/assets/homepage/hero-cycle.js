(() => {
  const hero = document.querySelector('#info-home .info-hero');
  if (!hero || !document.documentElement.classList.contains('informational-home')) return;
  const slides = [...hero.querySelectorAll('.info-hero-slide')];
  const dots = [...hero.querySelectorAll('.info-cycle-dots button')];
  const pause = hero.querySelector('.info-cycle-pause');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let index = 0, paused = reduced.matches, hovered = false, focused = false, timer;
  function show(next) {
    index = (next + slides.length) % slides.length;
    slides.forEach((slide, i) => slide.classList.toggle('is-active', i === index));
    dots.forEach((dot, i) => dot.setAttribute('aria-pressed', String(i === index)));
  }
  function schedule() {
    clearInterval(timer);
    if (!paused && !hovered && !focused && !document.hidden) timer = setInterval(() => show(index + 1), 6000);
  }
  function updatePause() {
    pause.textContent = paused ? '▶' : 'Ⅱ';
    pause.setAttribute('aria-label', paused ? 'Play slideshow' : 'Pause slideshow');
    schedule();
  }
  dots.forEach((dot, i) => dot.addEventListener('click', () => { show(i); schedule(); }));
  pause.addEventListener('click', () => { paused = !paused; updatePause(); });
  hero.addEventListener('mouseenter', () => { hovered = true; schedule(); });
  hero.addEventListener('mouseleave', () => { hovered = false; schedule(); });
  hero.addEventListener('focusin', () => { focused = true; schedule(); });
  hero.addEventListener('focusout', event => { if (!hero.contains(event.relatedTarget)) { focused = false; schedule(); } });
  document.addEventListener('visibilitychange', schedule);
  reduced.addEventListener('change', () => { paused = reduced.matches; updatePause(); });
  updatePause();
})();
