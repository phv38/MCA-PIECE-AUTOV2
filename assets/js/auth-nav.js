function updateAuthenticationLinks(session) {
  const isConnected = Boolean(session?.user);
  const destination = isConnected ? 'compte.html' : 'connexion.html';
  const label = isConnected ? 'Compte' : 'Connexion';

  document.querySelectorAll('.navbar-nav a[href="connexion.html"], .navbar-nav a[href="login.html"], .navbar-nav a[href="compte.html"]').forEach((link) => {
    link.href = destination;
    link.textContent = label;
  });
}

async function initializeAuthenticationLinks() {
  if (!window.mcaAuth?.isConfigured()) return;

  const { data, error } = await window.mcaAuth.getSession();
  if (!error) updateAuthenticationLinks(data?.session);

  window.supabaseClient.auth.onAuthStateChange((_event, session) => {
    updateAuthenticationLinks(session);
  });
}

document.addEventListener('DOMContentLoaded', initializeAuthenticationLinks);
