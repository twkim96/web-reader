// Catalog interactions only; replace with the target application's state/actions.
(() => {
  const root = document.body;
  const toast = document.querySelector('#toast');
  let toastTimer;
  const announce = message => {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toastTimer = setTimeout(() => { toast.textContent = ''; }, 3200);
  };
  const syncSamples = () => {
    document.querySelectorAll('.kit-material-preview, .kit-texture').forEach(sample => {
      sample.dataset.theme = root.dataset.theme;
      if (root.dataset.accent) sample.dataset.accent = root.dataset.accent;
      else delete sample.dataset.accent;
    });
  };
  ['theme', 'material', 'texture', 'accent'].forEach(name => {
    document.getElementById(name).addEventListener('change', event => {
      if (name === 'accent' && event.target.value === 'theme default') delete root.dataset.accent;
      else root.dataset[name] = event.target.value;
      syncSamples();
    });
  });
  document.addEventListener('click', event => {
    const target = event.target.closest('button');
    if (!target || target.disabled) return;
    if (target.dataset.open) document.getElementById(target.dataset.open).showModal();
    if (target.hasAttribute('data-close')) target.closest('dialog').close();
    if (target.dataset.demo) announce(target.dataset.demo);
    if (target.hasAttribute('data-toggle')) target.setAttribute('aria-pressed', target.getAttribute('aria-pressed') !== 'true' ? 'true' : 'false');
    const group = target.closest('[data-choice-group]');
    if (group) group.querySelectorAll('[aria-pressed]').forEach(choice => choice.setAttribute('aria-pressed', String(choice === target)));
  });
  document.querySelectorAll('dialog').forEach(dialog => {
    // A search input otherwise consumes Escape to clear text before dialog cancel.
    dialog.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      dialog.close();
    }, { capture: true });
    let pointerStartedOutside = false;
    const outside = event => {
      const bounds = dialog.getBoundingClientRect();
      return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
    };
    dialog.addEventListener('pointerdown', event => { pointerStartedOutside = outside(event); });
    dialog.addEventListener('click', event => {
      if (event.target === dialog && pointerStartedOutside && outside(event)) dialog.close();
      pointerStartedOutside = false;
    });
  });
  document.querySelector('#jump-form').addEventListener('submit', event => {
    event.preventDefault();
    announce(`${event.target.querySelector('input').value}% 위치로 이동하는 예시입니다.`);
    document.getElementById('jump').close();
  });
  document.querySelector('#search input').addEventListener('input', event => {
    const query = event.target.value.trim().toLocaleLowerCase();
    let count = 0;
    document.querySelectorAll('[data-result]').forEach(result => {
      result.hidden = !result.dataset.result.toLocaleLowerCase().includes(query);
      if (!result.hidden) count++;
    });
    document.querySelector('.kit-search-empty').hidden = count > 0;
  });
})();
