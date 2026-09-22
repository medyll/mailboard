// Le serveur local remplace cette réponse à la volée et fournit un jeton éphémère.
// En file://, le dashboard reste strictement en lecture seule.
window.MAILBOARD_SETTINGS = Object.freeze({ enabled: false, token: null });
