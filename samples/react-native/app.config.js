// app.json plus settings from the environment. EXPO_BASE_URL serves the web export under a
// sub-path (the GitHub Pages build sets /subetha/samples/expo); unset, it's served from /.
module.exports = ({ config }) => ({
  ...config,
  experiments: { ...config.experiments, ...(process.env.EXPO_BASE_URL ? { baseUrl: process.env.EXPO_BASE_URL } : {}) },
});
