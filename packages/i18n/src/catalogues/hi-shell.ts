import type { Catalogue } from './catalogue-type.js';

/** Hindi strings for the P26b U2 app shell, auth and onboarding (key set identical to en-shell.ts). */
export const hiShell = {
  'nav.overview': 'अवलोकन',
  'nav.messaging': 'मैसेजिंग',
  'nav.audience': 'ऑडियंस',
  'nav.messages': 'भेजें',
  'nav.webhooks': 'वेबहुक',
  'nav.apiKeys': 'API कीज़',
  'nav.wallet': 'वॉलेट',
  'nav.security': 'सुरक्षा',

  'shell.theme.label': 'थीम',
  'shell.theme.system': 'सिस्टम',
  'shell.theme.light': 'लाइट',
  'shell.theme.dark': 'डार्क',
  'shell.sidebar.collapse': 'संक्षिप्त करें',
  'shell.userMenu.trigger': 'खाता मेनू खोलें',
  'shell.topBar.openNav': 'नेविगेशन खोलें',
  'shell.commandPalette.placeholder': 'पेज खोजें…',
  'shell.commandPalette.empty': 'कोई मेल खाता पेज नहीं मिला।',
  'shell.commandPalette.inputLabel': 'पेज खोजें',

  'shell.authLayout.tagline': 'आपकी पूरी टीम के लिए भरोसेमंद WhatsApp मैसेजिंग।',
  'shell.authLayout.bulletDurable':
    'हर संदेश एक स्थायी जॉब के रूप में शुरू होता है - कुछ भी खोता नहीं है।',
  'shell.authLayout.bulletHealth': 'हर जुड़े हुए नंबर के लिए लाइव हेल्थ मॉनिटरिंग।',
  'shell.authLayout.bulletTenant': 'आपका वर्कस्पेस डेटा हर दूसरे टेनेंट से अलग रहता है।',

  'shell.notFound.title': 'पेज नहीं मिला',
  'shell.notFound.body': 'आप जिस पेज को खोज रहे हैं वह मौजूद नहीं है या स्थानांतरित हो गया है।',
  'shell.notFound.homeLink': 'डैशबोर्ड पर जाएं',

  'shell.errorBoundary.title': 'कुछ गलत हो गया',
  'shell.errorBoundary.body': 'यह पेज लोड नहीं हो सका। कृपया फिर से प्रयास करें।',
  'shell.errorBoundary.retryButton': 'पुनः प्रयास करें',

  'shell.stepper.completed': 'पूर्ण',
  'shell.stepper.current': 'वर्तमान चरण',
  'shell.stepper.upcoming': 'आगामी',

  'shell.wizard.stepVerifyEmail': 'ईमेल सत्यापित करें',
  'shell.wizard.stepTimezone': 'समय क्षेत्र',
  'shell.wizard.stepPacingProfile': 'पेसिंग प्रोफ़ाइल',
  'shell.wizard.stepConsent': 'सहमति',
  'shell.wizard.stepConnect': 'एक नंबर कनेक्ट करें',
  'shell.wizard.continueToDashboard': 'डैशबोर्ड पर जारी रखें',
  'shell.wizard.connectSecureAccountTitle': 'पहले अपना खाता सुरक्षित करें',
  'shell.wizard.connectSecureAccountBody':
    'नंबर कनेक्ट करने से पहले टू-फैक्टर ऑथेंटिकेशन आवश्यक है। सेट होने के बाद आपको फिर से साइन इन करना होगा।',

  'shell.auth.showPassword': 'पासवर्ड दिखाएं',
  'shell.auth.hidePassword': 'पासवर्ड छिपाएं',
  'shell.auth.passwordStrength': 'पासवर्ड की मजबूती',
  'shell.auth.passwordStrength.weak': 'कमजोर',
  'shell.auth.passwordStrength.fair': 'ठीक',
  'shell.auth.passwordStrength.good': 'अच्छा',
  'shell.auth.passwordStrength.strong': 'मजबूत',
  'shell.auth.signupLoginLink': 'साइन इन करें',
  'shell.auth.loginSignupLink': 'एक बनाएं',
  'shell.auth.devMailpitHint': 'डेवलपमेंट: सत्यापन ईमेल देखने के लिए Mailpit खोलें।',
  'shell.auth.backToSignIn': 'साइन इन पर वापस जाएं',
  'shell.auth.forgotPasswordLink': 'पासवर्ड भूल गए?',
  'shell.auth.recoveryCodesCopyHint':
    'जारी रखने से पहले हर कोड कॉपी करें - ये एक बार दिखाए जाते हैं।',
  'shell.auth.totpEnrolContinueButton': 'टू-फैक्टर सक्रिय करने के लिए फिर से साइन इन करें',

  'settings.security.title': 'सुरक्षा',
  'settings.security.email.title': 'ईमेल',
  'settings.security.email.verified': 'सत्यापित',
  'settings.security.email.notVerified': 'सत्यापित नहीं',
  'settings.security.mfa.title': 'टू-फैक्टर ऑथेंटिकेशन',
  'settings.security.mfa.notSetUp': 'सेट नहीं है',
  'settings.security.mfa.enabledSince': '{date} से सक्रिय',
  'settings.security.mfa.reenrolNotAvailable':
    'रिकवरी कोड सेटअप के समय एक बार दिखाए गए थे। टू-फैक्टर को फिर से सेट करना अभी पैनल में उपलब्ध नहीं है।',
  'settings.security.password.title': 'पासवर्ड',
  'settings.security.password.currentLabel': 'मौजूदा पासवर्ड',
  'settings.security.password.newLabel': 'नया पासवर्ड',
  'settings.security.password.newDescription': 'कम से कम 12 अक्षर।',
  'settings.security.password.confirmLabel': 'नए पासवर्ड की पुष्टि करें',
  'settings.security.password.confirmMismatch': 'पासवर्ड मेल नहीं खाते।',
  'settings.security.password.submitButton': 'पासवर्ड बदलें',
  'settings.security.password.successToast': 'आपका पासवर्ड बदल दिया गया है।',
  'settings.security.password.otherSessionsRevoked':
    'आपकी सुरक्षा के लिए आपके अन्य सत्रों को साइन आउट कर दिया गया है।',
  'settings.security.password.wrongCurrentPassword': 'वह मौजूदा पासवर्ड गलत है।',
  'settings.security.password.genericError': 'कुछ गलत हो गया। कृपया फिर से प्रयास करें।',
  'settings.security.session.title': 'सत्र',

  'shell.auth.forgotPassword.title': 'पासवर्ड भूल गए?',
  'shell.auth.forgotPassword.description':
    'अपना खाता ईमेल दर्ज करें और हम आपको पासवर्ड रीसेट करने के लिए एक लिंक भेजेंगे।',
  'shell.auth.forgotPassword.emailLabel': 'ईमेल',
  'shell.auth.forgotPassword.submitButton': 'रीसेट लिंक भेजें',
  'shell.auth.forgotPassword.confirmation':
    'यदि उस ईमेल के लिए कोई खाता मौजूद है, तो हमने एक लिंक भेज दिया है। यह 30 मिनट में समाप्त हो जाता है।',
  'shell.auth.forgotPassword.backToSignIn': 'साइन इन पर वापस जाएं',

  'shell.auth.resetPassword.title': 'अपना पासवर्ड रीसेट करें',
  'shell.auth.resetPassword.description': 'अपने खाते के लिए एक नया पासवर्ड चुनें।',
  'shell.auth.resetPassword.newLabel': 'नया पासवर्ड',
  'shell.auth.resetPassword.confirmLabel': 'नए पासवर्ड की पुष्टि करें',
  'shell.auth.resetPassword.confirmMismatch': 'पासवर्ड मेल नहीं खाते।',
  'shell.auth.resetPassword.submitButton': 'पासवर्ड रीसेट करें',
  'shell.auth.resetPassword.successToast': 'आपका पासवर्ड रीसेट कर दिया गया है। कृपया साइन इन करें।',
  'shell.auth.resetPassword.invalidTokenTitle': 'यह लिंक मान्य नहीं है',
  'shell.auth.resetPassword.invalidTokenBody':
    'यह रीसेट लिंक समाप्त हो गया है या पहले ही उपयोग किया जा चुका है।',
  'shell.auth.resetPassword.requestNewLinkButton': 'नया लिंक मांगें',

  'impersonation.banner.active': 'सपोर्ट सत्र · {staffLabel} · {scope} · {countdown} में समाप्त',
  'impersonation.banner.ended': 'सपोर्ट सत्र समाप्त हो गया',
  'impersonation.banner.scopeMetadataOnly': 'केवल खाता मेटाडेटा',
  'impersonation.banner.scopeWithBodies': 'संदेश सामग्री तक पहुंच दी गई',
  'impersonation.banner.endSessionButton': 'सत्र समाप्त करें',

  'impersonation.entry.invalidTitle': 'यह सपोर्ट सत्र लिंक मान्य नहीं है',
  'impersonation.entry.invalidBody':
    'यह लिंक गुम है या समाप्त हो गया है। कृपया एक नया लिंक मांगें।',
  'impersonation.entry.returnToLoginButton': 'लॉगिन पर वापस जाएं',
} as const satisfies Catalogue;
