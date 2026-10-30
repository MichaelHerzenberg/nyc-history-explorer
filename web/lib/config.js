// Central settings. Everything the app talks to is listed here so it can be
// checked, swapped or re-pointed in one place.

export const APP_NAME = 'NYC History Explorer';
export const VERSION = '0.1.0';

// Midtown pilot: 23rd–59th Streets, 3rd–9th Avenues. Corners were taken from
// NYC GeoSearch for the corner addresses (Oct 2026) and padded slightly so
// corner buildings fall inside. [longitude, latitude] pairs, closed ring.
export const PILOT_POLYGON = [
  [-74.0025, 40.7468], // W 23rd St & 9th Ave
  [-73.9826, 40.7378], // E 23rd St & 3rd Ave
  [-73.9656, 40.7612], // E 59th St & 3rd Ave
  [-73.9862, 40.7700], // W 59th St & 9th Ave
  [-74.0025, 40.7468],
];

export const PILOT_WKT =
  'MULTIPOLYGON(((' + PILOT_POLYGON.map(([x, y]) => `${x} ${y}`).join(',') + ')))';

export const MAP_START = { lat: 40.7527, lng: -73.9840, zoom: 15 };

export const GEOSEARCH = 'https://geosearch.planninglabs.nyc/v2';
export const SOCRATA = 'https://data.cityofnewyork.us/resource';

// NYC Open Data dataset IDs (all verified reachable 2026-10-27).
export const DATASETS = {
  footprints: '5zhs-2jue',     // Building Footprints (OTI)
  pluto: '64uk-42ks',          // PLUTO tax-lot data (City Planning)
  lpcBuildings: 'gpmc-yuvp',   // LPC Individual Landmark & Historic District Building Database
  lpcDesignations: 'ncre-qhxs',// LPC Designated and Calendared Buildings and Sites
  dobJobs: 'ic3t-wcy2',        // DOB Job Application Filings (BIS, ~1989 onward)
  dobNowJobs: 'w9ak-ipjd',     // DOB NOW: Build – Job Application Filings (~2016 onward)
  dobCO: 'bs8b-p36w',          // DOB Certificate of Occupancy
  dobViolations: '3h2n-5cm9',  // DOB Violations
  ecbViolations: '6bgk-3dad',  // DOB ECB Violations
  dobComplaints: 'eabe-havv',  // DOB Complaints Received
  acrisLegals: '8h5j-fqxa',    // ACRIS Real Property Legals
  acrisMaster: 'bnx9-e6tj',    // ACRIS Real Property Master
  acrisParties: '636b-3b5g',   // ACRIS Real Property Parties
  acrisCodes: '7isb-wh4c',     // ACRIS Document Control Codes
};

// Optional free Socrata app token (raises rate limits). Not required.
// Get one at https://data.cityofnewyork.us/profile/edit/developer_settings
export const SOCRATA_APP_TOKEN = '';
