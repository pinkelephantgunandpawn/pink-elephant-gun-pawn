(() => {
  const nav = document.querySelector('#info-home-header .info-nav');
  if (!nav) return;
  const menus = [...nav.querySelectorAll('details.info-menu')];
  function closeExcept(active) { menus.forEach(menu => { if (menu !== active) menu.open = false; }); }
  menus.forEach(menu => {
    const summary = menu.querySelector('summary');
    summary.addEventListener('click', event => {
      event.preventDefault();
      const opening = !menu.open;
      closeExcept(menu);
      menu.open = opening;
    });
    menu.addEventListener('toggle', () => { if (menu.open) closeExcept(menu); });
  });
  document.addEventListener('click', event => { if (!nav.contains(event.target)) closeExcept(null); });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const active = menus.find(menu => menu.open);
    closeExcept(null);
    if (active) active.querySelector('summary').focus();
  });
  nav.addEventListener('click', event => { if (event.target.closest('a')) closeExcept(null); });
})();
