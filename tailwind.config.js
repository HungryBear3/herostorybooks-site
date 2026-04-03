/** @type {import('tailwindcss').Config} */
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/app/**/*.{js,ts,jsx,tsx}',
    './src/components/**/*.{js,ts,jsx,tsx}'
  ],
  theme: {
    extend: {
      colors: {
        purple: '#5B4A8A',
        peach: '#E8A87C',
        cream: '#FDF8F4'
      }
    }
  },
  plugins: []
};
