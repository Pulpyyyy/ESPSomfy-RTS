# Migrer depuis ESPSomfy-RTS v2.x (rstrouse / xkain)

Ce guide décrit la migration d'un boîtier ESPSomfy-RTS v2.x existant
(projet original de rstrouse, ou fork xkain) vers ce firmware. Tout
l'intérêt de la procédure est que **vous conservez tout** : volets,
pièces, groupes, adresses des télécommandes et — point crucial — les
**rolling codes**, donc aucun volet n'a besoin d'être ré-appairé.

Le format de sauvegarde est versionné champ par champ depuis le projet
d'origine. La restauration d'une ancienne sauvegarde sur ce firmware a
été **vérifiée de bout en bout avec une vraie sauvegarde au format
v2.5.6** : chaque champ est relu à l'identique, et les champs ajoutés
par ce fork prennent des valeurs neutres (`liftTime` 0 = désactivé,
`curveGain` 0 = pas de correction). Les sauvegardes de toutes les
versions 2.x sont acceptées.

## Avant de commencer

- Un ordinateur et un câble USB pour atteindre le boîtier (le
  changement de partitions est la seule étape impossible par OTA).
- [esptool](https://github.com/espressif/esptool) installé
  (`pip install esptool`), ou votre outil de flash ESP32 habituel.
- 10 minutes.

## Étape 1 — Sauvegardez votre configuration actuelle

Dans l'interface web **actuelle** (v2.x) :

1. Ouvrez la page des réglages et repérez la section **Sauvegarde**.
2. Téléchargez le fichier de sauvegarde (`*.backup`) et gardez-le en
   lieu sûr.

Ce fichier contient vos volets, pièces, groupes, télécommandes liées,
répéteurs et rolling codes. C'est la seule chose à emporter. **Ne
sautez pas cette étape.**

## Étape 2 — Flashez l'image onboard v3.x par USB

Le firmware v3.x utilise une partition applicative plus grande
(1,69 Mo par slot OTA au lieu de 1,31 Mo), ce qui laisse de la marge
pour les évolutions futures. Une table de partitions ne peut pas être
changée par OTA, d'où cet unique flash USB. Toutes les mises à jour
suivantes redeviennent des OTA classiques.

1. Téléchargez `SomfyController.onboard.esp32.bin` (ou la variante de
   votre carte) depuis la
   [page des releases](https://github.com/Pulpyyyy/ESPSomfy-RTS/releases).
2. Branchez le boîtier en USB et flashez l'image à l'offset 0 :

   ```
   esptool.py -p <PORT> write_flash 0x0 SomfyController.onboard.esp32.bin
   ```

   Remplacez `<PORT>` par votre port série (`COM5`, `/dev/ttyUSB0`, ...).

Le boîtier démarre avec une configuration vierge.

## Étape 3 — Premier démarrage et réseau

Avec sa configuration vierge, le boîtier démarre en point d'accès
WiFi :

1. Depuis un téléphone ou un portable, rejoignez le réseau
   **`ESPSomfyRTS`** (mot de passe WPA2 : **`espsomfy`** — fixe et
   documenté à dessein, il ne protège que l'accès au point d'accès).
2. Ouvrez **http://192.168.4.1** dans un navigateur.
3. Saisissez les identifiants de votre WiFi et enregistrez. Le boîtier
   redémarre et rejoint votre réseau ; le point d'accès disparaît.
4. Retrouvez sa nouvelle adresse (liste des clients DHCP de votre box,
   ou l'adresse que vous lui aviez réservée) et ouvrez l'interface web.

Si vous protégez l'interface par un PIN ou un mot de passe,
configurez-le maintenant — une installation neuve démarre sans
sécurité.

## Étape 4 — Restaurez votre sauvegarde

Dans la **nouvelle** interface web :

1. Allez dans la section sauvegarde/restauration des réglages.
2. Envoyez le fichier de sauvegarde de l'étape 1.
3. Cochez au minimum **Volets** (les pièces, groupes et répéteurs en
   font partie). La restauration des réglages réseau est optionnelle —
   vous venez de les configurer, garder les nouveaux est recommandé.
4. Lancez la restauration. Le boîtier redémarre.

Après le redémarrage, tous les volets sont revenus — noms, pièces,
ordre de tri, adresses et rolling codes compris. Rien à ré-appairer :
appuyez sur une télécommande appairée, le compteur de trames reprend
exactement où il s'était arrêté.

## Étape 5 — Vérifiez, puis refaites une sauvegarde

1. Vérifiez que tous les volets sont listés et répondent.
2. Créez immédiatement une **nouvelle** sauvegarde depuis ce firmware.
   Le nouveau fichier utilise le format courant (avec `liftTime` et
   `curveGain` par volet) et devient votre référence.

> **Retour en arrière ?** Conservez l'*ancien* fichier de sauvegarde
> v2.x. Une sauvegarde écrite par ce firmware utilise un format
> d'enregistrement plus récent qu'un boîtier v2.x rejette (sans
> danger — son contrôle de taille refuse le fichier). Pour revenir en
> v2.x : flashez l'ancienne image onboard et restaurez l'ancien
> fichier.

## Home Assistant

L'API HTTP/WebSocket est inchangée : l'intégration officielle
ESPSomfy-RTS-HA continue de fonctionner, entités et tableaux de bord
conservés. Ce fork s'annonce sous un URN SSDP différent : la
découverte automatique ne fonctionne qu'avec l'intégration compagnon
[ESPSomfy-RTS Enhanced](https://github.com/Pulpyyyy/ESPSomfy-RTS-enhanced) ;
avec l'intégration officielle, ajoutez le boîtier par son adresse IP.

## Dépannage

- **La restauration (ou tout envoi de fichier) bloque ou se termine
  sans réponse** alors que les pages se chargent normalement : si vous
  atteignez le boîtier à travers un VPN ou un réseau overlay, c'est
  presque toujours un problème de MTU — les segments TCP pleins sont
  jetés silencieusement. Abaissez la MTU du tunnel (p. ex. 1380 au
  lieu de 1420) ou faites la migration depuis une machine sur le même
  LAN que le boîtier.
- **« Fichier non valide » à l'envoi** : l'interface vérifie le
  *contenu* du fichier (octets magiques), pas son nom. Vérifiez que
  vous avez choisi le fichier de sauvegarde pour une restauration,
  l'image `littlefs` pour une mise à jour d'interface, et l'image
  firmware pour une mise à jour du firmware.
- **La mise à jour est refusée avec une erreur de taille** : le
  firmware vérifie les images contre la taille réelle du slot OTA
  avant d'écrire — c'est le garde-fou qui fonctionne, pas un bug.
  Vérifiez que l'image correspond à votre table de partitions.
