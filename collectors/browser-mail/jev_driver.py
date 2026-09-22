"""Navigation par jev-ultrafast, pour les vues qu'on ne sait pas décrire à l'avance.

Le collecteur Node sait atteindre une boîte dont le chemin est fixe. Quand il ne
sait pas — un webmail inconnu, une vue derrière un parcours qui change — ce
pilote laisse JEV choisir les actions : il reçoit un but en langage naturel, la
table des éléments observés, et répond par une opération et une cible.

Frontières, codées ici et pas confiées au prompt :

  - on s'attache à un navigateur déjà lancé, via BU_CDP_URL ;
  - l'origine de la page est vérifiée après chaque action, et une sortie du
    périmètre arrête la session ;
  - TYPE_TEXT est refusé par défaut : taper du texte demande un second modèle,
    et rien ne doit être saisi dans une boîte mail sans décision explicite ;
  - l'extraction n'est pas faite par le modèle. Une fois la vue atteinte, ce
    sont les expressions de providers/*.mjs qui lisent la page.

Entrée : un JSON sur stdin.  Sortie : un JSON sur stdout.
Aucun contenu de mail n'est journalisé ; seuls statuts, compteurs et URL.
"""

import json
import os
import sys
import time
from urllib.parse import urlparse


def fail(status, message, **extra):
    json.dump({"status": status, "message": message, **extra}, sys.stdout)
    sys.stdout.write("\n")
    sys.exit(0 if status == "ok" else 1)


def origin(url):
    try:
        parts = urlparse(url)
        return f"{parts.scheme}://{parts.netloc}" if parts.scheme and parts.netloc else None
    except ValueError:
        return None


def main():
    request = json.load(sys.stdin)

    allowed = request.get("allowedOrigins") or []
    goals = request.get("goals") or []
    url = request.get("url")
    if not url or not goals:
        fail("error", "url et goals sont requis")
    if origin(url) not in allowed:
        fail("error", f"url de départ hors périmètre : {origin(url)}")

    # Le harnais parle à un navigateur déjà lancé plutôt que d'en ouvrir un :
    # la session mail reste celle de l'utilisateur, sous son contrôle.
    os.environ.setdefault("BU_CDP_URL", request.get("cdpUrl") or "http://127.0.0.1:9222")

    if not os.environ.get("TYPESAFE_API_KEY"):
        fail("needs_user", "TYPESAFE_API_KEY absente : la navigation JEV ne peut pas décider")

    try:
        from jev_ultrafast import Agent
    except ImportError as exc:
        fail("unavailable", f"jev-ultrafast non installé ({exc}) — voir le README du collecteur")

    max_steps = int(request.get("maxSteps") or 25)
    allow_type_text = bool(request.get("allowTypeText"))
    probes = request.get("probes") or {}

    agent = None
    try:
        agent = Agent(url, goals)
        steps = 0
        state = agent.state

        for state in agent.run():
            steps += 1

            page_url = (state.get("page") or {}).get("url") or ""
            if origin(page_url) not in allowed:
                fail(
                    "error",
                    f"sortie de périmètre : {origin(page_url)}",
                    steps=steps,
                )

            # L'opération choisie est lisible dans l'historique ; on refuse la
            # saisie de texte avant qu'elle ne s'exécute une seconde fois.
            history = state.get("history") or []
            if not allow_type_text and any(
                (entry.get("operation") or entry.get("op")) == "TYPE_TEXT" for entry in history
            ):
                fail("error", "TYPE_TEXT refusé : saisie non autorisée sur ce canal", steps=steps)

            if steps >= max_steps:
                fail("partial", f"but non atteint en {max_steps} actions", steps=steps)

        status = state.get("status")
        page_url = (state.get("page") or {}).get("url") or ""
        if status != "done":
            fail("partial", f"JEV s'est arrêté en {status}", steps=steps, url=page_url)

        # La vue est atteinte, mais « atteinte » ne veut pas dire « rendue » :
        # une liste peut encore être en squelette. On attend la sonde de
        # disponibilité avant de lire quoi que ce soit, sinon on collecte des
        # lignes sans date ni état de lecture.
        ready_name = request.get("readyProbe") or "listReady"
        if ready_name in probes:
            for _ in range(int(request.get("readyTries") or 24)):
                if agent.browser.evaluate(probes[ready_name]):
                    break
                time.sleep(float(request.get("readyDelay") or 0.5))

        # L'extraction repasse au code du fournisseur.
        results = {}
        for name, expression in probes.items():
            results[name] = agent.browser.evaluate(expression)

        json.dump({"status": "ok", "steps": steps, "url": page_url, "probes": results}, sys.stdout)
        sys.stdout.write("\n")
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 — toute panne devient un statut, jamais une trace brute
        fail("error", f"{type(exc).__name__}: {exc}")
    finally:
        # L'onglet créé par l'agent est refermé ; le navigateur, jamais.
        if agent is not None:
            try:
                agent.close()
            except Exception:  # noqa: BLE001
                pass


if __name__ == "__main__":
    main()
