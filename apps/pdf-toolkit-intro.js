let storedTheme = 'light';
try {
  storedTheme = localStorage.getItem('theme') || 'light';
} catch {
  // Storage can be disabled by browser privacy settings.
}

if (storedTheme === 'dark') document.body.classList.add('dark-mode');

document.querySelectorAll('.theme-toggle').forEach(button => {
  button.addEventListener('click', () => {
    document.body.classList.toggle('dark-mode');
    const theme = document.body.classList.contains('dark-mode') ? 'dark' : 'light';
    try {
      localStorage.setItem('theme', theme);
    } catch {
      // The visual switch still works when storage is unavailable.
    }
  });
});
