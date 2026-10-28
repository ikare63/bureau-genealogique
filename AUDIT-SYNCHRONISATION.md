# Audit et correction de la synchronisation privée — 28 octobre 2026

État : corrections proposées sur `audit/private-sync-20261028`. Aucun déploiement demandé, aucune fusion dans `main`, aucune sauvegarde personnelle modifiée pendant l'audit. Les tests utilisent des données fictives. Les dépôts sources ont été lus directement depuis GitHub, sans archive ZIP.

## Constats vérifiés

| Élément | Cause | Correction proposée |
|---|---|---|
| 3615 ne voit plus Arboris, Scriptoria et Pistoria | Le tableau de bord et l'intégration lisent uniquement les anciennes clés localStorage, supprimées lors de la migration des bases vers IndexedDB. 3615 ne possède aucun téléchargement authentifié de ces bases. | Lecture des bases IndexedDB de l'appareil ; lecture authentifiée de `ikare63/data` dans un cache distinct ; affichage sans réinjecter les anciennes grosses clés localStorage. |
| Scriptoria ne peut pas relire son JSON privé | L'ancien client force `Accept: application/vnd.github+json`, même quand le lecteur demande le média raw. GitHub ne fournit pas `content` pour les fichiers entre 1 et 100 Mo. | Métadonnées au média object, contenu au média raw via l'API Git blobs, épinglé au SHA du fichier. La sauvegarde Scriptoria observée dépasse 1 Mo. |
| Versions incomplètes susceptibles d'écraser les autres | Comparaison de dates d'export/synchronisation et absence de base commune fiable dans les trois applications généalogiques. Le SHA lu juste avant l'écriture protège contre une concurrence instantanée, mais pas contre une ancienne copie locale. | SHA distant + empreinte du document synchronisé ; première divergence et modifications sur deux appareils bloquées ; choix explicite de résolution ; aucun réessai d'écrasement après 409/422. |
| Téléphone et PC restent indépendants | IndexedDB et localStorage appartiennent à chaque navigateur. Les anciens boutons n'envoient qu'au clic et les jetons restent en session. | Circuit explicite dans chaque application, téléchargement sur un autre appareil, automatisation facultative après une première réussite dans l'onglet. |
| CAP et Culina | Aucun transport GitHub trouvé dans les modules actifs ; les sauvegardes et passerelles locales ne traversent pas les appareils. | Adaptateurs vers `cap.json` et `culina.json` dans le dépôt privé. CAP conserve les récompenses ; Culina conserve ses champs persistants et ses recettes personnelles. |
| Scribe | Bloc de fonctions GitHub placé à l'intérieur de `renderNav`, inaccessible aux fonctions de sauvegarde, avec réinstallation des événements à chaque rendu. | Bloc placé dans la portée principale, installation unique, transport commun protégé. |
| Scriptoria : démarrage et export | Fonctions de rappel supprimées encore appelées ; callbacks hors de l'IIFE appelant des fonctions internes. | Rétablissement des fonctions de rappel et déplacement des callbacks dans leur portée correcte. |
| Migrations locales | Des bases et sauvegardes historiques sont supprimées après migration, et une erreur d'initialisation peut laisser une base vide éditable. | Conservation des chaînes et lignes originales dans le coffre de récupération avant migration ; arrêt de l'édition si l'initialisation protégée échoue. |
| Statut trompeur dans 3615 | Trois bases locales présentes suffisaient à afficher « À JOUR ». | « 3 BASES DISPONIBLES » et statut de lecture GitHub séparé, daté et détaillé par source. |

## Garantie de récupération avant remplacement

1. Chaque application conserve une copie locale de secours dans `lenaic-safe-sync-v1`, store `snapshots`. Les copies ont un identifiant unique ; aucun nettoyage automatique n'est effectué.
2. Avant une migration, les chaînes localStorage originales, la base IndexedDB et les sauvegardes ciblées sont archivées, y compris une chaîne JSON illisible.
3. Avant un remplacement distant, la version distante et la version de cet appareil sont écrites sous des noms uniques dans `data/recovery/<application>/`. Chaque copie distante est relue et son empreinte vérifiée avant de toucher au JSON principal.
4. L'écriture du JSON principal utilise le SHA lu. Une modification concurrente provoque un arrêt, pas une nouvelle tentative avec le dernier SHA.
5. Avant un chargement local, les deux documents sont archivés ; les modifications locales pendant les opérations sont détectées. L'import des fichiers et de l'état Scriptoria utilise une transaction IndexedDB commune.
6. Le bouton **Secours JSON** exporte les copies conservées. Une résolution sélectionne une version principale ; elle ne réalise pas une fusion automatique des fiches. Les versions non retenues restent récupérables.

La synchronisation complète de Scriptoria inclut les fichiers images/PDF de son store `files`, sous la forme `{data, files}` ; les anciennes sauvegardes directes ou enveloppées restent lisibles. Les fichiers locaux non présents dans une version distante ne sont pas supprimés. Un document complet supérieur à 90 Mo est refusé avant remplacement : la limite de l'API est de 100 Mo, et GitHub n'est pas adapté à une photothèque volumineuse.

## Authentification et confidentialité

Le moteur accepte uniquement `ikare63/data` et le fichier correspondant à l'application. Il vérifie que le dépôt est privé. Il envoie le jeton dans l'en-tête Authorization, jamais dans une URL, un commit, un JSON ou un journal. Le jeton saisi reste dans sessionStorage de l'onglet et le champ est vidé après saisie. Les jetons de session existants sont réutilisables.

Sur chaque appareil, utiliser un jeton à portée fine limité au dépôt `data`, avec **Contents: Read and write** pour synchroniser. La lecture seule du tableau de bord peut utiliser **Contents: Read**. Le moteur n'ajoute aucun secret au workflow public de miroir JSON de 3615 : ce workflow reste réservé aux ressources publiques.

GitHub Pages peut appeler directement l'API GitHub avec ce jeton ; aucun serveur personnel ni logiciel installé n'est requis. Le navigateur doit rester ouvert pour l'automatisation. Les scripts de la même origine GitHub Pages peuvent accéder au stockage de session : un jeton limité à `data`, à durée limitée, réduit les conséquences d'un script compromis. Un service intermédiaire d'authentification serait nécessaire pour éviter entièrement la saisie d'un jeton dans une application statique.

## Validation réalisée

- 17 tests automatisés du véritable moteur, avec API GitHub et IndexedDB simulés : comparaison, première divergence, mises à jour sur deux appareils, SHA, fichiers UTF-8, lecture raw, absence de jeton, 401/403/409/422, dépôt public, branche inexistante, quota local, échec de vérification d'une copie distante, modification pendant l'envoi, annulation, retour à la copie locale après échec, migration, documents avec fichiers et modification d'un fichier seul.
- Démarrage des huit pages principales dans un environnement DOM simulé avec IndexedDB vierge : Arboris, Scriptoria, Pistoria, Ariane, Scribe, 3615, CAP et Culina. Aucun échec JavaScript ni erreur d'initialisation après correction ; les panneaux attendus sont présents.
- Vérification de syntaxe des JavaScript modifiés et des scripts exécutables intégrés aux HTML ; vérification des différences Git.
- Aucun test n'a lu les jetons des appareils, ni écrit de sauvegarde réelle dans le dépôt privé. Le stockage local du téléphone et du PC n'est pas accessible depuis le navigateur cloud. La validation de bout en bout sur les données réelles reste donc à faire après revue et intégration.

Reproduire le moteur : `npm ci && npm test` dans ce dépôt. Aucun paquet de test n'est chargé par les applications.

## Fichiers concernés

| Dépôt | Fichiers fonctionnels |
|---|---|
| bureau-genealogique | `index.html`, `index2.html`, `index3.html`, `lenaic-integration.js`, nouveau `lenaic-sync.js` |
| 3615lenaic | `index.html`, `js/app.js`, `js/ecosystem-v2.js`, nouveau `js/lenaic-sync.js` |
| cap | `index.html`, `js/cap-main.js`, nouveau `js/lenaic-sync.js` |
| culina | `index.html`, `app.js`, `service-worker.js`, nouveau `lenaic-sync.js` |
| aide_archive | `Ariane.html`, `Scribe-v3.html`, nouveau `lenaic-sync.js` |

Le moteur identique est inclus dans chaque dépôt pour conserver l'indépendance des applications et éviter qu'une modification non intégrée dans un autre dépôt bloque le chargement. Les sources personnelles et les sauvegardes ne figurent dans aucun de ces changements.

## Première récupération après validation

1. **Téléphone en premier** : ne pas vider les données de navigation, désinstaller la PWA ou importer une ancienne copie du PC. Avant mise à jour, utiliser les exports JSON déjà présents ; Scriptoria dispose d'un export complet avec fichiers. Conserver ces secours sur le téléphone, sans devoir les transmettre.
2. Après intégration des corrections, ouvrir l'application sur le téléphone, développer **Synchronisation sécurisée**, exporter la base locale complète, puis saisir le jeton de session. D'abord **Comparer et synchroniser**.
3. Si les versions divergent, vérifier les copies et les nombres présentés. Le téléphone étant la copie la plus complète connue, choisir **Envoyer cet appareil (résolution explicite)** uniquement depuis ce téléphone après cette vérification. Attendre la réussite datée. Les anciennes versions distantes sont archivées avant remplacement.
4. Sur le PC, faire un secours local, saisir le jeton puis choisir **Charger GitHub (résolution explicite)**. Comparer les quantités et les dernières modifications avec le téléphone, puis activer éventuellement l'automatisation dans chaque onglet. Ne pas commencer par envoyer une copie ancienne du PC.
5. Dans 3615, utiliser **Sources généalogiques privées → Actualiser depuis GitHub privé**. Cette lecture ne remplace pas les bases des applications. Après la première lecture, un retour dans l'onglet réactualise cette vue tant que la session est disponible.
6. Fermer puis rouvrir chaque application sur chaque appareil pour vérifier la persistance, puis faire une petite modification identifiable sur le téléphone, synchroniser, la charger sur le PC et la vérifier dans 3615. Toute erreur doit interrompre cette procédure : conserver les secours, ne pas forcer un nouvel envoi depuis le PC.

Il est impossible de certifier la complétude du téléphone en inspectant seulement les dépôts GitHub. Les quantités et données affichées sur les appareils doivent être comparées pendant cette première récupération. La revue des branches précède toute fusion ; aucune production n'a été publiée automatiquement.
