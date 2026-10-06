(function () {
  const nav = document.currentScript?.previousElementSibling?.matches?.('nav')
    ? document.currentScript.previousElementSibling
    : document.querySelector('nav.navbar');
  if (!nav) return;

  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = 'assets/css/header.css';
  document.head.appendChild(stylesheet);

  const page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  const isActive = (...files) => (files.includes(page) ? ' is-active' : '');

  nav.className = 'mca-header';
  nav.removeAttribute('data-bs-theme');
  nav.innerHTML = `
    <div class="mca-header__inner">
      <a class="mca-header__brand" href="index.html" aria-label="MCA Pièces Autos 38">
        <span class="mca-header__logo"><i class="fa-solid fa-car-side"></i></span>
        <span>MCA PIÈCES AUTOS 38</span>
      </a>
      <button class="mca-header__toggle" type="button" aria-expanded="false" aria-controls="mcaHeaderMenu" aria-label="Ouvrir le menu">
        <i class="fa-solid fa-bars"></i>
      </button>
      <div class="mca-header__menu" id="mcaHeaderMenu">
        <ul class="mca-header__links">
          <li><a class="mca-header__link${isActive('index.html')}" href="index.html">Accueil</a></li>
          <li><a class="mca-header__link${isActive('services.html')}" href="services.html">Services</a></li>
          <li><a class="mca-header__link${isActive('galerie.html')}" href="galerie.html">Galerie</a></li>
          <li><a class="mca-header__link${isActive('contact.html')}" href="contact.html">Contact</a></li>
        </ul>
        <div class="mca-header__actions">
          <a class="mca-header__link${isActive('catalogue.html')}" href="catalogue.html">Catalogue</a>
          <a class="mca-header__link${isActive('compte.html', 'login.html', 'register.html', 'detail-commande.html', 'admin.html')}" href="compte.html" data-mca-account>Compte</a>
          <a class="mca-header__cart${isActive('panier.html')}" href="panier.html">
            <i class="fa-solid fa-bag-shopping"></i><span>Panier</span>
            <span class="mca-header__badge" data-cart-count hidden>0</span>
          </a>
          <button class="mca-header__logout" type="button" data-mca-logout>
            <i class="fa-solid fa-right-from-bracket"></i><span>Déconnexion</span>
          </button>
        </div>
      </div>
    </div>`;

  const toggle = nav.querySelector('.mca-header__toggle');
  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
  });

  nav.querySelector('[data-mca-logout]').addEventListener('click', async () => {
    try {
      if (window.mcaAuth?.signOut) await window.mcaAuth.signOut();
    } catch (error) {
      console.error('Déconnexion impossible:', error);
    }
    window.location.href = 'login.html';
  });

  function updateCartBadge() {
    let count = 0;
    try {
      const items = JSON.parse(localStorage.getItem('mca_cart') || localStorage.getItem('mca_panier') || '[]');
      count = (Array.isArray(items) ? items : []).reduce((sum, item) => sum + (Number(item.quantite ?? item.quantity) || 0), 0);
    } catch (error) {
      count = 0;
    }
    nav.querySelectorAll('[data-cart-count]').forEach((badge) => {
      badge.textContent = String(count);
      badge.hidden = count === 0;
    });
  }

  updateCartBadge();
  window.addEventListener('storage', updateCartBadge);
  window.addEventListener('load', updateCartBadge);
})();
