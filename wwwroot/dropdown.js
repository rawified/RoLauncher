"use strict";
/* =========================================================
   Styled dropdowns.
   Every <select> gets a themed button + floating menu. The real <select> stays in
   the page (hidden) and keeps being the source of truth, so code that reads or sets
   .value, fills in <option>s, toggles .hidden or listens for "change" keeps working.
   ========================================================= */
(() => {
  const CARET = `<svg class="dd-caret" viewBox="0 0 12 12"><path d="M3 4.5l3 3 3-3"/></svg>`;
  const CHECK = `<svg class="dd-check" viewBox="0 0 12 12"><path d="M2.5 6.2l2.3 2.3 4.7-5"/></svg>`;
  let open = null; // { sel, wrap, menu, idx }

  function enhance(sel) {
    if (sel._dd || sel.multiple) return;
    const wrap = document.createElement("div");
    wrap.className = ("dd " + sel.className).trim();
    if (sel.id) wrap.dataset.for = sel.id;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dd-btn";
    btn.title = sel.title || "";
    btn.setAttribute("aria-haspopup", "listbox");
    btn.innerHTML = `<span class="dd-label"></span>${CARET}`;
    sel.parentNode.insertBefore(wrap, sel);
    wrap.append(sel, btn);
    sel.className = "dd-native";
    sel.tabIndex = -1;
    sel.setAttribute("aria-hidden", "true");
    sel._dd = { wrap, btn };

    // Programmatic .value / .selectedIndex changes update the label too.
    for (const prop of ["value", "selectedIndex"]) {
      const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop);
      Object.defineProperty(sel, prop, {
        configurable: true,
        get() { return d.get.call(this); },
        set(v) { d.set.call(this, v); sync(sel); },
      });
    }
    new MutationObserver(() => sync(sel)).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "disabled", "selected", "title"] });
    sel.addEventListener("change", () => sync(sel));

    btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); open && open.sel === sel ? close() : show(sel); });
    btn.addEventListener("keydown", (e) => {
      if (open && open.sel === sel) return menuKey(e);
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); show(sel); }
    });
    sync(sel);
  }

  function sync(sel) {
    const { wrap, btn } = sel._dd;
    const o = sel.options[sel.selectedIndex];
    btn.querySelector(".dd-label").textContent = o ? o.textContent : "";
    wrap.hidden = sel.hidden;
    btn.disabled = sel.disabled;
    if (sel.title) btn.title = sel.title;
    if (open && open.sel === sel) render();
  }

  function show(sel) {
    close();
    if (sel.disabled || !sel.options.length) return;
    const menu = document.createElement("div");
    menu.className = "dd-menu";
    menu.setAttribute("role", "listbox");
    document.body.append(menu);
    open = { sel, wrap: sel._dd.wrap, menu, idx: Math.max(0, sel.selectedIndex) };
    open.wrap.classList.add("open");
    render();
    place();
    menu.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus on the button
    menu.addEventListener("click", (e) => {
      const it = e.target.closest("[data-i]");
      if (it && !it.classList.contains("disabled")) choose(Number(it.dataset.i));
    });
    menu.addEventListener("mousemove", (e) => {
      const it = e.target.closest("[data-i]");
      if (it && Number(it.dataset.i) !== open.idx) { open.idx = Number(it.dataset.i); highlight(); }
    });
    sel._dd.btn.focus({ preventScroll: true });
  }

  function render() {
    const { sel, menu } = open;
    menu.innerHTML = [...sel.options].map((o, i) =>
      `<div class="dd-item${i === sel.selectedIndex ? " sel" : ""}${o.disabled ? " disabled" : ""}${i === open.idx ? " hl" : ""}" role="option" data-i="${i}">${CHECK}<span></span></div>`).join("");
    [...menu.children].forEach((el, i) => { el.lastChild.textContent = sel.options[i].textContent; });
  }

  function highlight() {
    [...open.menu.children].forEach((el, i) => el.classList.toggle("hl", i === open.idx));
    const el = open.menu.children[open.idx];
    if (el) el.scrollIntoView({ block: "nearest" });
  }

  function place() {
    const r = open.wrap.getBoundingClientRect(), m = open.menu;
    m.style.minWidth = r.width + "px";
    const h = Math.min(m.scrollHeight, 320), below = innerHeight - r.bottom - 8, above = r.top - 8;
    const up = below < h && above > below;
    m.style.maxHeight = Math.max(120, Math.min(320, up ? above : below)) + "px";
    m.style.top = (up ? r.top - Math.min(h, above) - 6 : r.bottom + 6) + "px";
    m.classList.toggle("up", up);
    const left = Math.min(r.left, innerWidth - m.offsetWidth - 8);
    m.style.left = Math.max(8, left) + "px";
    highlight();
  }

  function choose(i) {
    const { sel } = open;
    close();
    if (i === sel.selectedIndex) return;
    sel.selectedIndex = i;
    sel.dispatchEvent(new Event("input", { bubbles: true }));
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function close() {
    if (!open) return;
    open.menu.remove();
    open.wrap.classList.remove("open");
    open = null;
  }

  let typed = "", typedAt = 0;
  function menuKey(e) {
    const n = open.sel.options.length;
    const step = (d) => { let i = open.idx; for (let k = 0; k < n; k++) { i = (i + d + n) % n; if (!open.sel.options[i].disabled) break; } open.idx = i; highlight(); };
    if (e.key === "ArrowDown") step(1);
    else if (e.key === "ArrowUp") step(-1);
    else if (e.key === "Home") { open.idx = 0; highlight(); }
    else if (e.key === "End") { open.idx = n - 1; highlight(); }
    else if (e.key === "Enter" || e.key === " ") choose(open.idx);
    else if (e.key === "Escape" || e.key === "Tab") { close(); if (e.key === "Tab") return; }
    else if (e.key.length === 1) {
      typed = Date.now() - typedAt > 700 ? e.key.toLowerCase() : typed + e.key.toLowerCase();
      typedAt = Date.now();
      const i = [...open.sel.options].findIndex((o) => o.textContent.trim().toLowerCase().startsWith(typed));
      if (i >= 0) { open.idx = i; highlight(); }
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  document.addEventListener("mousedown", (e) => { if (open && !open.menu.contains(e.target) && !open.wrap.contains(e.target)) close(); }, true);
  addEventListener("resize", close);
  addEventListener("blur", close);
  document.addEventListener("scroll", (e) => { if (open && !open.menu.contains(e.target)) close(); }, true);

  const all = () => document.querySelectorAll("select").forEach(enhance);
  all();
  new MutationObserver((ms) => { if (ms.some((m) => m.addedNodes.length)) all(); }).observe(document.body, { childList: true, subtree: true });
})();
