# Commute Check

A Chrome extension that overlays Luas, DART, and Irish Rail lines and stations on [Daft.ie](https://www.daft.ie) property maps — helping you find a home near public transit.

![Commute Check](icons/icon128.png)

## Features

- **Luas Lines & Stops** — Red and Green lines with all stops
- **DART Lines & Stations** — Dublin Area Rapid Transit network
- **Irish Rail Lines & Stations** — National rail network
- **Walking Radius Circles** — 5, 10, and 20-minute walking distances from any stop
- **Adjustable Opacity** — Control overlay transparency
- **Per-Layer Toggles** — Show/hide individual transit layers

## Installation

### From Chrome Web Store
*(Coming soon)*

### Manual Installation (Developer Mode)
1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked**
5. Select the extension folder

## Usage

1. Navigate to any property listing or search page on [daft.ie](https://www.daft.ie)
2. Click the extension icon in your browser toolbar
3. Toggle the master switch **ON**
4. Customize which layers to display
5. Hover over any stop to see its name and walking radius circles

## Privacy

This extension:
- Does **not** collect any personal data
- Does **not** track browsing activity
- Does **not** communicate with external servers
- Stores only your layer preferences locally in your browser

All transit data is bundled with the extension and processed entirely on your device.

## Data Sources

Transit data is derived from publicly available GTFS feeds:

- **Luas GTFS** — [NTA / Transport for Ireland](https://www.transportforireland.ie/transitData/PT_Data.html)
- **Irish Rail GTFS** — [NTA / Transport for Ireland](https://www.transportforireland.ie/transitData/PT_Data.html)

Contains Irish Public Sector Data licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## Disclaimer

This is an **unofficial** extension and is not affiliated with Daft.ie, Transport for Ireland, Luas, or Irish Rail. Transit data is provided as-is and may not reflect real-time service changes.

## License

MIT License — see [LICENSE](LICENSE) for details.

## Contributing

Contributions are welcome! Feel free to open issues or submit pull requests.
