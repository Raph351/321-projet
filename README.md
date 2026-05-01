# 📚 Library Microservices — Module 321

Application de gestion de bibliothèque construite avec une architecture microservices.

---

## 🏗️ Architecture générale

```
Client (browser / curl)
        │
        ▼
┌───────────────────┐
│      Traefik      │  API Gateway — port 80
│  (port 80/8080)   │  Dashboard  — port 8080
└───────┬───────────┘
        │
        ├── /books/* ──────────────────────────────────────┐
        │                                                   ▼
        │                                    ┌─────────────────────────┐
        │                                    │      book-catalog       │
        │                                    │    Python / FastAPI     │
        │                                    │   SQLite · port 8001    │
        │                                    │   Consumer RabbitMQ     │
        │                                    └──────────┬──────────────┘
        │                                               │ HTTP GET /books/{id}
        │                                               │ (service-to-service)
        └── /loans/* ──────────────────────────────────►│
                                             ┌──────────┴──────────────┐
                                             │      loan-service       │
                                             │    Node.js / Express    │
                                             │   SQLite · port 8002    │
                                             │   Publisher RabbitMQ    │
                                             └──────────┬──────────────┘
                                                        │
                                                        ▼
                                             ┌──────────────────────────┐
                                             │        RabbitMQ          │
                                             │  Exchange: loan_events   │
                                             │     Type: Direct         │
                                             │ Queue: book_availability │
                                             └──────────────────────────┘
```

---

## 🛠️ Technologies utilisées

| Service        | Langage      | Framework   | Base de données | Port         |
|----------------|--------------|-------------|-----------------|--------------|
| book-catalog   | Python 3.11  | FastAPI     | SQLite          | 8001         |
| loan-service   | Node.js 20   | Express     | SQLite          | 8002         |
| API Gateway    | —            | Traefik v2  | —               | 80 / 8080    |
| Message Broker | —            | RabbitMQ    | —               | 5672 / 15672 |

---

## 📦 Fonctionnalités

### `book-catalog` (Python / FastAPI)

| Méthode  | Route           | Description                   |
|----------|-----------------|-------------------------------|
| `GET`    | `/books`        | Lister tous les livres (filtrables par disponibilité et genre) |
| `GET`    | `/books/{id}`   | Obtenir un livre par ID        |
| `POST`   | `/books`        | Ajouter un livre au catalogue  |
| `PUT`    | `/books/{id}`   | Modifier un livre              |
| `DELETE` | `/books/{id}`   | Supprimer un livre             |

> **Consumer RabbitMQ :** écoute les événements `book.borrowed` et `book.returned` et met à jour la disponibilité automatiquement.

---

### `loan-service` (Node.js / Express)

| Méthode | Route                  | Description                                             |
|---------|------------------------|---------------------------------------------------------|
| `GET`   | `/loans`               | Lister tous les emprunts (filtrables par `status`) |
| `GET`   | `/loans/{id}`          | Obtenir un emprunt par ID                               |
| `POST`  | `/loans`               | Créer un emprunt (vérifie la dispo via HTTP → book-catalog, puis publie vers RabbitMQ) |
| `PUT`   | `/loans/{id}/return`   | Retourner un livre (publie vers RabbitMQ)               |

> **Publisher RabbitMQ :** publie `book.borrowed` ou `book.returned` sur l'exchange `loan_events`.

---

## 🚀 Installation & Exécution locale

### Prérequis

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows 11) ou Docker Engine
- Docker Compose v2

### Démarrage

```bash
# Cloner ou extraire le projet
cd library-ms

# Construire et démarrer tous les services
docker compose up --build -d

# Vérifier que tout est up
docker compose ps
```

### Arrêt

```bash
docker compose down -v
```

---

## 🌐 URLs des routes

### Via API Gateway Traefik (port 80)

| Service      | Méthode  | URL                              | Description          |
|--------------|----------|----------------------------------|----------------------|
| book-catalog | `GET`    | `http://localhost/books`         | Liste tous les livres |
| book-catalog | `GET`    | `http://localhost/books/{id}`    | Obtenir un livre      |
| book-catalog | `POST`   | `http://localhost/books`         | Ajouter un livre      |
| book-catalog | `PUT`    | `http://localhost/books/{id}`    | Modifier un livre     |
| book-catalog | `DELETE` | `http://localhost/books/{id}`    | Supprimer un livre    |
| loan-service | `GET`    | `http://localhost/loans`         | Liste tous les emprunts |
| loan-service | `GET`    | `http://localhost/loans/{id}`    | Obtenir un emprunt    |
| loan-service | `POST`   | `http://localhost/loans`         | Créer un emprunt      |
| loan-service | `PUT`    | `http://localhost/loans/{id}/return` | Retourner un livre |

### Accès direct (hors Gateway)

| Interface              | URL                                           |
|------------------------|-----------------------------------------------|
| Swagger book-catalog   | <http://localhost:8001/docs>                  |
| Swagger loan-service   | <http://localhost:8002/api-docs>              |
| Traefik Dashboard      | <http://localhost:8888>                       |
| RabbitMQ Management    | <http://localhost:15672> — `guest` / `guest`  |

---

## 🐇 RabbitMQ — Pattern et justification

### Pattern choisi : Direct Exchange (Routing)

```
loan-service  ──publish──►  Exchange "loan_events" (direct)
                                    │
                     ┌──────────────┴───────────────────┐
                     │ routing_key: book.borrowed        │ routing_key: book.returned
                     ▼                                   ▼
             Queue "book_availability"          Queue "book_availability"
                     │
                     ▼
             book-catalog (consumer)
```

### Événements publiés

| Routing Key     | Publié par   | Consommé par | Action résultante                     |
|-----------------|--------------|--------------|---------------------------------------|
| `book.borrowed` | loan-service | book-catalog | Marque le livre comme non disponible  |
| `book.returned` | loan-service | book-catalog | Remet le livre comme disponible       |

### Plus-value de RabbitMQ

Sans RabbitMQ, la mise à jour de disponibilité nécessiterait un appel HTTP synchrone supplémentaire du `loan-service` vers le `book-catalog` (`PUT /books/{id}`). Cette approche crée un **couplage fort** : si le `book-catalog` est indisponible, la mise à jour est perdue.

Avec RabbitMQ en mode **Direct Exchange** :

- **Découplage** — `loan-service` publie un événement et continue sans attendre la réponse
- **Fiabilité** — les messages sont persistants (`durable=true`) ; si `book-catalog` redémarre, il traite les événements en attente
- **Extensibilité** — un futur service (notifications, statistiques) peut s'abonner au même exchange sans modifier les services existants

---

## 🐳 Déploiement Docker Swarm

### Configuration minimale des VMs

| Paramètre | Minimum recommandé         |
|-----------|----------------------------|
| CPU       | 2 vCPU par VM              |
| RAM       | 2 Go par VM                |
| Disque    | 20 Go par VM               |
| OS        | Ubuntu 22.04 LTS           |
| VMs       | 1 manager + 1 worker (ou 1 nœud seul) |

> L'évaluation est testée sur : **PC Win11, Intel i7, 30 Go RAM, Oracle VirtualBox**.  
> Template VM disponible sur Moodle (Swisstransfer) pour machines Intel.

### Instructions de déploiement

```bash
# 1. Construire et tagger les images sur le nœud manager
docker build -t library-ms/book-catalog:latest ./book-catalog
docker build -t library-ms/loan-service:latest  ./loan-service

# 2. Initialiser le Swarm (une seule fois)
docker swarm init
# Note l'adresse IP du manager affichée — elle sera nécessaire pour les workers

# (Optionnel) Ajouter un worker
# Sur le nœud worker, coller la commande "docker swarm join --token ..." affichée

# 3. Déployer la stack
docker stack deploy -c docker-stack.yml library

# 4. Vérifier le déploiement
docker stack services library
docker stack ps library

# 5. Voir les logs d'un service
docker service logs library_book-catalog -f
docker service logs library_loan-service  -f

# 6. Supprimer la stack
docker stack rm library
```

### URLs Swarm

| Interface           | URL                                                  |
|---------------------|------------------------------------------------------|
| API Gateway         | `http://<IP_MANAGER>:80`                             |
| Traefik Dashboard   | `http://<IP_MANAGER>:8080`                           |
| Swarm Visualizer    | `http://<IP_MANAGER>:9000`                           |
| RabbitMQ Management | `http://<IP_MANAGER>:15672` — `guest` / `guest`      |

### Replicas configurés

| Service      | Replicas | Mode       |
|--------------|----------|------------|
| traefik      | 1/node   | global     |
| rabbitmq     | 1        | replicated |
| book-catalog | 2        | replicated |
| loan-service | 2        | replicated |

---

## 🧪 Test rapide avec curl

```bash
# Lister les livres
curl http://localhost/books

# Voir un livre spécifique
curl http://localhost/books/1

# Créer un emprunt
curl -X POST http://localhost/loans \
  -H "Content-Type: application/json" \
  -d '{"book_id": 1, "borrower_name": "Alice Martin"}'

# Le livre est maintenant indisponible (mis à jour via RabbitMQ)
curl http://localhost/books/1

# Retourner le livre
curl -X PUT http://localhost/loans/1/return
```

---

## 📁 Structure du projet

```
library-ms/
├── book-catalog/
│   ├── main.py             # FastAPI app + RabbitMQ consumer
│   ├── requirements.txt
│   └── Dockerfile
├── loan-service/
│   ├── app.js              # Express app + RabbitMQ publisher
│   ├── package.json
│   └── Dockerfile
├── docker-compose.yml      # Déploiement local (avec Traefik)
├── docker-stack.yml        # Déploiement Docker Swarm
└── README.md
```
