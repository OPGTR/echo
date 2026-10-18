# Écho

Un lecteur de musique Android 100 % sur le téléphone :

- **Ta musique hors ligne** : Écho lit les fichiers audio de tes dossiers (FLAC, MP3, AAC/M4A, ALAC, Opus, OGG, WAV…), avec pochettes, albums, artistes, titres aimés.
- **Des découvertes** : chaque jour, des mixes faits avec ce que tu écoutes (y compris tes fichiers locaux) et un mix « Découvertes » d'artistes proches que tu n'as pas encore.
- **Télécharger en un geste** : touche un titre que tu n'as pas, il se télécharge (extension Deezer de SpotiFLAC) puis se lit. Les titres arrivent dans `Musique/Écho/Artiste/Album/`.

## Installer

Télécharge l'APK sur la page [Releases](../../releases/tag/latest) :
la plupart des téléphones prennent **arm64-v8a**.

## Comment ça marche

- `app/` : l'interface (React), pensée pour le téléphone.
- `server/` : le serveur local d'Écho (bibliothèque SQLite, lecture, recommandations, téléchargements), qui tourne dans l'appli grâce à un Node.js embarqué et n'écoute que sur `127.0.0.1`, protégé par un jeton.
- `server/spotiflac/` : le moteur d'extensions SpotiFLAC, repris de [Lokal](https://github.com/sipbuu/lokal) (MIT).
- `android/` : l'appli Android (Capacitor).

Les téléchargements sont copiés par flux (sans `copyfile` ni `chmod`, refusés par le stockage Android) et, si un dossier refuse l'écriture, Écho passe au suivant : `Musique/Écho`, puis le dossier média de l'appli.

## Développer

```
npm ci
npm run build          # interface + serveur
npm test               # le serveur sous les limites du téléphone (Node 18 sans ICU)
npx cap sync android && cd android && ./gradlew assembleRelease
```

Chaque push sur `main` construit les APK avec GitHub Actions et les publie sur la pré-version `latest`.
Pour signer avec ta propre clé, ajoute les secrets `ECHO_KEYSTORE_BASE64`, `ECHO_KEYSTORE_PASSWORD`, `ECHO_KEY_ALIAS`, `ECHO_KEY_PASSWORD`.
