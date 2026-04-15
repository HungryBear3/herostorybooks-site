/** @type {import('tailwindcss').Config} */
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/app/**/*.{js,ts,jsx,tsx}',
    './src/components/**/*.{js,ts,jsx,tsx}'
  ],
  theme: {
    extend: {
      fontFamily: {
        serif: ['Playfair Display', 'Georgia', 'serif'],
      },
      colors: {
        purple: '#5B4A8A',
        peach: '#E8A87C',
        cream: '#FDF8F4',
        lavender: '#F0EDF8',
        'deep-gold': '#C9A227',
        forest: '#2D5016'
      }
    }
  },
  plugins: []
};
