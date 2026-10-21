// Where Nanit lives. Tests point these at a local fake (test/fake-nanit.js).
export const NANIT = {
  api: "https://api.nanit.com",
  socket: "wss://api.nanit.com/focus/cameras",
  media: "rtmps://media-secured.nanit.com/nanit",
};

// The app's requests look like Nanit's own iOS app, which is what the API expects.
export const HEADERS = { "nanit-api-version": "1", "User-Agent": "Nanit/767 CFNetwork/1498.700.2 Darwin/23.6.0" };
