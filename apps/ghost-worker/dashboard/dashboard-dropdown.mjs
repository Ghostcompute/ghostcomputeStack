/** Reusable chip-style dropdown for dashboard.html (custom UI + hidden native select). */

/** @type {Map<string, HTMLSelectElement>} */
const registry = new Map();

/** @type {Map<string, { wrapper: HTMLElement, trigger: HTMLButtonElement, menu: HTMLElement, labelEl: HTMLElement, select: HTMLSelectElement }>} */
const wrappers = new Map();

/** @type {Set<{ wrapper: HTMLElement, trigger: HTMLButtonElement, menu: HTMLElement, labelEl: HTMLElement, select: HTMLSelectElement }>} */
const openMenus = new Set();

let docListenerBound = false;
let repositionBound = false;

function selectedLabel(select) {
  const opt = select.options[select.selectedIndex];
  return opt?.textContent?.trim() || '';
}

function positionMenu(meta) {
  const { trigger, menu, wrapper } = meta;
  const rect = trigger.getBoundingClientRect();
  const gap = 6;
  const minWidth = Math.max(rect.width, 160);

  menu.style.position = 'fixed';
  menu.style.left = `${Math.max(8, rect.left)}px`;
  menu.style.minWidth = `${minWidth}px`;
  menu.style.width = wrapper.classList.contains('gc-dd--field') ? `${rect.width}px` : '';
  menu.style.zIndex = '1000';

  menu.hidden = false;
  const menuHeight = menu.offsetHeight;
  const spaceBelow = window.innerHeight - rect.bottom - gap;
  const spaceAbove = rect.top - gap;

  if (menuHeight > spaceBelow && spaceAbove > spaceBelow) {
    menu.style.top = `${Math.max(8, rect.top - gap - menuHeight)}px`;
  } else {
    menu.style.top = `${rect.bottom + gap}px`;
  }
}

function openMenu(meta) {
  const { wrapper, trigger, menu } = meta;
  closeAllMenus();
  document.body.appendChild(menu);
  menu.classList.add('gc-dd__menu--floating');
  wrapper.classList.add('open');
  trigger.setAttribute('aria-expanded', 'true');
  positionMenu(meta);
  openMenus.add(meta);
}

function closeMenu(meta) {
  const { wrapper, trigger, menu } = meta;
  wrapper.classList.remove('open');
  trigger.setAttribute('aria-expanded', 'false');
  menu.hidden = true;
  menu.classList.remove('gc-dd__menu--floating');
  menu.style.position = '';
  menu.style.top = '';
  menu.style.left = '';
  menu.style.minWidth = '';
  menu.style.width = '';
  menu.style.zIndex = '';
  wrapper.appendChild(menu);
  openMenus.delete(meta);
}

function closeAllMenus() {
  [...openMenus].forEach(closeMenu);
}

function repositionOpenMenus() {
  openMenus.forEach(positionMenu);
}

function bindDocumentListener() {
  if (docListenerBound || typeof document === 'undefined') return;
  docListenerBound = true;
  document.addEventListener('click', closeAllMenus);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllMenus();
  });
}

function bindRepositionListeners() {
  if (repositionBound || typeof window === 'undefined') return;
  repositionBound = true;
  window.addEventListener('scroll', repositionOpenMenus, true);
  window.addEventListener('resize', repositionOpenMenus);
}

function rebuildMenu(select, menu) {
  menu.innerHTML = '';
  [...select.options].forEach((opt) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gc-dd__option';
    btn.role = 'option';
    btn.dataset.value = opt.value;
    btn.textContent = opt.textContent;
    btn.setAttribute('aria-selected', opt.selected ? 'true' : 'false');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      select.value = opt.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      syncDropdownUi(select);
      closeAllMenus();
    });
    menu.appendChild(btn);
  });
}

function syncDropdownUi(select) {
  const meta = wrappers.get(select.id);
  if (!meta) return;
  meta.labelEl.textContent = selectedLabel(select);
  meta.menu.querySelectorAll('.gc-dd__option').forEach((btn) => {
    btn.setAttribute('aria-selected', btn.dataset.value === select.value ? 'true' : 'false');
  });
}

function refreshIcons(node) {
  if (typeof window !== 'undefined' && window.lucide?.createIcons) {
    window.lucide.createIcons({ nodes: [node] });
  }
}

function upgradeSelect(select) {
  if (select.dataset.ddUpgraded === '1') return select;

  bindDocumentListener();
  bindRepositionListeners();

  const variant = select.dataset.dropdown || 'compact';
  const wrapper = document.createElement('div');
  wrapper.className = `gc-dd gc-dd--${variant}`;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = variant === 'field'
    ? 'gc-dd__trigger gc-dd__trigger--field'
    : 'gc-dd__trigger chip';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');

  const ariaLabel = select.getAttribute('aria-label');
  if (ariaLabel) trigger.setAttribute('aria-label', ariaLabel);

  const labelEl = document.createElement('span');
  labelEl.className = 'gc-dd__label';

  const chev = document.createElement('i');
  chev.dataset.lucide = 'chevron-down';
  chev.className = 'gc-dd__chev';

  trigger.append(labelEl, chev);

  const menu = document.createElement('div');
  menu.className = 'gc-dd__menu';
  menu.role = 'listbox';
  menu.hidden = true;
  menu.addEventListener('click', (e) => e.stopPropagation());

  select.classList.add('gc-dd__native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  select.dataset.ddUpgraded = '1';

  const parent = select.parentNode;
  parent.insertBefore(wrapper, select);
  wrapper.append(trigger, menu, select);

  const meta = { wrapper, trigger, menu, labelEl, select };

  if (select.id) {
    registry.set(select.id, select);
    wrappers.set(select.id, meta);
  }

  rebuildMenu(select, menu);
  syncDropdownUi(select);
  refreshIcons(chev);

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (wrapper.classList.contains('open')) {
      closeMenu(meta);
    } else {
      openMenu(meta);
    }
  });

  return select;
}

/**
 * @param {HTMLSelectElement} select
 * @param {{ value: string, label: string, disabled?: boolean }[]} options
 * @param {{ placeholder?: string, value?: string, preserveSelection?: boolean }} [opts]
 */
export function populateDropdownOptions(select, options, opts = {}) {
  const { placeholder, value, preserveSelection = true } = opts;
  const prev = preserveSelection ? select.value : undefined;

  select.innerHTML = '';

  if (placeholder !== undefined) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = placeholder;
    select.appendChild(opt);
  }

  for (const item of options) {
    const opt = document.createElement('option');
    opt.value = item.value;
    opt.textContent = item.label;
    if (item.disabled) opt.disabled = true;
    select.appendChild(opt);
  }

  if (value !== undefined) {
    select.value = value;
  } else if (prev && [...select.options].some(o => o.value === prev)) {
    select.value = prev;
  }

  const meta = wrappers.get(select.id);
  if (meta) rebuildMenu(select, meta.menu);
  syncDropdownUi(select);
}

/**
 * @param {{
 *   id?: string,
 *   options?: { value: string, label: string, disabled?: boolean }[],
 *   value?: string,
 *   variant?: 'chip' | 'compact' | 'field',
 *   ariaLabel?: string,
 *   className?: string,
 *   placeholder?: string,
 *   onChange?: (value: string, select: HTMLSelectElement) => void,
 * }} config
 * @returns {HTMLSelectElement}
 */
export function createDropdown(config) {
  const {
    id,
    options = [],
    value,
    variant = 'compact',
    ariaLabel,
    className = '',
    placeholder,
    onChange,
  } = config;

  const select = document.createElement('select');
  if (id) select.id = id;
  if (ariaLabel) select.setAttribute('aria-label', ariaLabel);
  select.dataset.dropdown = variant;
  if (className) select.className = className;

  populateDropdownOptions(select, options, { placeholder, value, preserveSelection: false });

  if (onChange) {
    select.addEventListener('change', () => onChange(select.value, select));
  }

  return select;
}

/**
 * @param {HTMLElement|string} target
 * @param {Parameters<typeof createDropdown>[0]} config
 * @returns {HTMLSelectElement}
 */
export function mountDropdown(target, config) {
  const el = typeof target === 'string' ? document.getElementById(target) : target;
  if (!el) throw new Error('mountDropdown: target not found');

  const select = createDropdown(config);
  el.appendChild(select);
  upgradeSelect(select);
  return select;
}

/** @param {HTMLSelectElement|string} selectOrId */
export function getDropdown(selectOrId) {
  if (typeof selectOrId === 'string') {
    return registry.get(selectOrId) || document.getElementById(selectOrId);
  }
  return selectOrId;
}

/**
 * @param {HTMLSelectElement|string} selectOrId
 * @param {{ value: string, label: string, disabled?: boolean }[]} options
 * @param {{ placeholder?: string, preserveSelection?: boolean }} [opts]
 */
export function setDropdownOptions(selectOrId, options, opts = {}) {
  const select = getDropdown(selectOrId);
  if (!select) return;
  populateDropdownOptions(select, options, opts);
  const meta = wrappers.get(select.id);
  if (meta && openMenus.has(meta)) positionMenu(meta);
}

/** Upgrade declarative `<select data-dropdown="…">` elements in the page. */
export function initDashboardDropdowns(root = document) {
  root.querySelectorAll('select[data-dropdown]').forEach((select) => {
    upgradeSelect(select);
    if (select.id) registry.set(select.id, select);
  });
}
