import type { Catalogue } from './catalogue-type.js';

/** Hindi strings for the 2026-09-08 dashboard refresh; mirrors en-dashboard.ts key for key. */
export const hiDashboard = {
  'dashboard.kpi.connectedNumbers.needsAction': '{count} पर ध्यान देना ज़रूरी है',
  'dashboard.kpi.connectedNumbers.allHealthy': 'सभी स्वस्थ',
  'dashboard.kpi.connectedNumbers.noneConnected': 'अभी तक कोई नहीं जुड़ा',
  'dashboard.kpi.queued.acrossNumbers': '{count} नंबरों में',
  'dashboard.kpi.sent.failedToday': 'आज, {failed} विफल',
  'dashboard.kpi.spentToday.balance': 'बैलेंस {balance}',

  'dashboard.numbers.cardTitle': 'आज की भेजाई',
  'dashboard.numbers.meta.waiting': 'प्रतीक्षा में {count}',

  'dashboard.outcomes.cardTitle': 'आज के परिणाम',
  'dashboard.outcomes.label': 'आज के परिणाम',
  'dashboard.outcomes.centre.messages': 'संदेश',
  'dashboard.outcomes.centre.empty': 'आज अभी तक कुछ नहीं भेजा गया',
  'dashboard.outcomes.segment.sent': 'भेजे गए',
  'dashboard.outcomes.segment.failed': 'विफल',
  'dashboard.outcomes.segment.waiting': 'प्रतीक्षा में',

  'dashboard.fleetHealth.cardTitle': 'फ्लीट स्वास्थ्य',
  'dashboard.fleetHealth.label': 'फ्लीट स्वास्थ्य 100 में से {score}',
  'dashboard.fleetHealth.empty': 'स्वास्थ्य ट्रैक करना शुरू करने के लिए एक नंबर कनेक्ट करें',
  'dashboard.fleetHealth.band.HEALTHY': 'स्वस्थ',
  'dashboard.fleetHealth.band.WATCH': 'निगरानी में',
  'dashboard.fleetHealth.band.DEGRADED': 'कमजोर',
  'dashboard.fleetHealth.band.CRITICAL': 'गंभीर',

  'dashboard.wallet.cardTitle': 'वॉलेट',
  'dashboard.wallet.estimate':
    'मौजूदा अधिकतम दर पर लगभग {count} संदेश - यह एक अनुमान है, वादा नहीं।',
  'dashboard.wallet.addFunds': 'राशि जोड़ें',
} as const satisfies Catalogue;
