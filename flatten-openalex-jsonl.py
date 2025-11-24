import csv
import glob
import gzip
import json
import os
import sys

SNAPSHOT_DIR = 'openalex-snapshot'
CSV_DIR = 'csv-files'

if not os.path.exists(CSV_DIR):
    os.mkdir(CSV_DIR)

FILES_PER_ENTITY = int(os.environ.get('OPENALEX_DEMO_FILES_PER_ENTITY', '0'))

csv_files = {
    'authors': {
        'authors': {
            'name': os.path.join(CSV_DIR, 'authors.csv.gz'),
            'columns': [
                'id', 'orcid', 'display_name', 'display_name_alternatives',
                'works_count', 'cited_by_count',
                'last_known_institution', 'works_api_url', 'updated_date',
            ]
        },
        'ids': {
            'name': os.path.join(CSV_DIR, 'authors_ids.csv.gz'),
            'columns': [
                'author_id', 'openalex', 'orcid', 'scopus', 'twitter',
                'wikipedia', 'mag'
            ]
        },
        'counts_by_year': {
            'name': os.path.join(CSV_DIR, 'authors_counts_by_year.csv.gz'),
            'columns': [
                'author_id', 'year', 'works_count', 'cited_by_count',
                'oa_works_count'
            ]
        }
    },
    'concepts': {
        'concepts': {
            'name': os.path.join(CSV_DIR, 'concepts.csv.gz'),
            'columns': [
                'id', 'wikidata', 'display_name', 'level', 'description',
                'works_count', 'cited_by_count', 'image_url',
                'image_thumbnail_url', 'works_api_url', 'updated_date'
            ]
        },
        'ancestors': {
            'name': os.path.join(CSV_DIR, 'concepts_ancestors.csv.gz'),
            'columns': ['concept_id', 'ancestor_id']
        },
        'counts_by_year': {
            'name': os.path.join(CSV_DIR, 'concepts_counts_by_year.csv.gz'),
            'columns': ['concept_id', 'year', 'works_count', 'cited_by_count',
                        'oa_works_count']
        },
        'ids': {
            'name': os.path.join(CSV_DIR, 'concepts_ids.csv.gz'),
            'columns': ['concept_id', 'openalex', 'wikidata', 'wikipedia',
                        'umls_aui', 'umls_cui', 'mag']
        },
        'related_concepts': {
            'name': os.path.join(CSV_DIR, 'concepts_related_concepts.csv.gz'),
            'columns': ['concept_id', 'related_concept_id', 'score']
        }
    },
    'topics': {
        'topics': {
            'name': os.path.join(CSV_DIR, 'topics.csv.gz'),
            'columns': ['id', 'display_name', 'subfield_id',
                        'subfield_display_name', 'field_id',
                        'field_display_name',
                        'domain_id', 'domain_display_name', 'description',
                        'keywords', 'works_api_url', 'wikipedia_id',
                        'works_count', 'cited_by_count', 'updated_date', 'siblings']
        }
    },
    'institutions': {
        'institutions': {
            'name': os.path.join(CSV_DIR, 'institutions.csv.gz'),
            'columns': [
                'id', 'ror', 'display_name', 'country_code', 'type',
                'homepage_url', 'image_url', 'image_thumbnail_url',
                'display_name_acronyms', 'display_name_alternatives',
                'works_count', 'cited_by_count', 'works_api_url',
                'updated_date'
            ]
        },
        'ids': {
            'name': os.path.join(CSV_DIR, 'institutions_ids.csv.gz'),
            'columns': [
                'institution_id', 'openalex', 'ror', 'grid', 'wikipedia',
                'wikidata', 'mag'
            ]
        },
        'geo': {
            'name': os.path.join(CSV_DIR, 'institutions_geo.csv.gz'),
            'columns': [
                'institution_id', 'city', 'geonames_city_id', 'region',
                'country_code', 'country', 'latitude',
                'longitude'
            ]
        },
        'associated_institutions': {
            'name': os.path.join(CSV_DIR,
                                 'institutions_associated_institutions.csv.gz'),
            'columns': [
                'institution_id', 'associated_institution_id', 'relationship'
            ]
        },
        'counts_by_year': {
            'name': os.path.join(CSV_DIR, 'institutions_counts_by_year.csv.gz'),
            'columns': [
                'institution_id', 'year', 'works_count', 'cited_by_count',
                'oa_works_count'
            ]
        }
    },
    'publishers': {
        'publishers': {
            'name': os.path.join(CSV_DIR, 'publishers.csv.gz'),
            'columns': [
                'id', 'display_name', 'alternate_titles', 'country_codes',
                'hierarchy_level', 'parent_publisher',
                'works_count', 'cited_by_count', 'sources_api_url',
                'updated_date'
            ]
        },
        'counts_by_year': {
            'name': os.path.join(CSV_DIR, 'publishers_counts_by_year.csv.gz'),
            'columns': ['publisher_id', 'year', 'works_count', 'cited_by_count',
                        'oa_works_count']
        },
        'ids': {
            'name': os.path.join(CSV_DIR, 'publishers_ids.csv.gz'),
            'columns': ['publisher_id', 'openalex', 'ror', 'wikidata']
        },
    },
    'sources': {
        'sources': {
            'name': os.path.join(CSV_DIR, 'sources.csv.gz'),
            'columns': [
                'id', 'issn_l', 'issn', 'display_name', 'publisher',
                'works_count', 'cited_by_count', 'is_oa',
                'is_in_doaj', 'homepage_url', 'works_api_url', 'updated_date'
            ]
        },
        'ids': {
            'name': os.path.join(CSV_DIR, 'sources_ids.csv.gz'),
            'columns': ['source_id', 'openalex', 'issn_l', 'issn', 'mag',
                        'wikidata', 'fatcat']
        },
        'counts_by_year': {
            'name': os.path.join(CSV_DIR, 'sources_counts_by_year.csv.gz'),
            'columns': ['source_id', 'year', 'works_count', 'cited_by_count',
                        'oa_works_count']
        },
    },
    'works': {
        'works': {
            'name': os.path.join(CSV_DIR, 'works.csv.gz'),
            'columns': [
                'id', 'doi', 'title', 'display_name', 'publication_year',
                'publication_date', 'type', 'cited_by_count',
                'is_retracted', 'is_paratext', 'cited_by_api_url',
                'abstract_inverted_index', 'language'
            ]
        },
        'primary_locations': {
            'name': os.path.join(CSV_DIR, 'works_primary_locations.csv.gz'),
            'columns': [
                'work_id', 'source_id', 'landing_page_url', 'pdf_url', 'is_oa',
                'version', 'license'
            ]
        },
        'locations': {
            'name': os.path.join(CSV_DIR, 'works_locations.csv.gz'),
            'columns': [
                'work_id', 'source_id', 'landing_page_url', 'pdf_url', 'is_oa',
                'version', 'license'
            ]
        },
        'best_oa_locations': {
            'name': os.path.join(CSV_DIR, 'works_best_oa_locations.csv.gz'),
            'columns': [
                'work_id', 'source_id', 'landing_page_url', 'pdf_url', 'is_oa',
                'version', 'license'
            ]
        },
        'authorships': {
            'name': os.path.join(CSV_DIR, 'works_authorships.csv.gz'),
            'columns': [
                'work_id', 'author_position', 'author_id', 'institution_id',
                'raw_affiliation_string'
            ]
        },
        'biblio': {
            'name': os.path.join(CSV_DIR, 'works_biblio.csv.gz'),
            'columns': [
                'work_id', 'volume', 'issue', 'first_page', 'last_page'
            ]
        },
        'topics': {
            'name': os.path.join(CSV_DIR, 'works_topics.csv.gz'),
            'columns': [
                'work_id', 'topic_id', 'score'
            ]
        },
        'concepts': {
            'name': os.path.join(CSV_DIR, 'works_concepts.csv.gz'),
            'columns': [
                'work_id', 'concept_id', 'score'
            ]
        },
        'ids': {
            'name': os.path.join(CSV_DIR, 'works_ids.csv.gz'),
            'columns': [
                'work_id', 'openalex', 'doi', 'mag', 'pmid', 'pmcid'
            ]
        },
        'mesh': {
            'name': os.path.join(CSV_DIR, 'works_mesh.csv.gz'),
            'columns': [
                'work_id', 'descriptor_ui', 'descriptor_name', 'qualifier_ui',
                'qualifier_name', 'is_major_topic'
            ]
        },
        'open_access': {
            'name': os.path.join(CSV_DIR, 'works_open_access.csv.gz'),
            'columns': [
                'work_id', 'is_oa', 'oa_status', 'oa_url',
                'any_repository_has_fulltext'
            ]
        },
        'referenced_works': {
            'name': os.path.join(CSV_DIR, 'works_referenced_works.csv.gz'),
            'columns': [
                'work_id', 'referenced_work_id'
            ]
        },
        'related_works': {
            'name': os.path.join(CSV_DIR, 'works_related_works.csv.gz'),
            'columns': [
                'work_id', 'related_work_id'
            ]
        },
    },
}

def sorted_jsonl_files(entity):
    return sorted(
        glob.glob(os.path.join(SNAPSHOT_DIR, 'data', entity, '*', '*.gz')),
        key=lambda path: (os.path.dirname(path), os.path.basename(path))
    )


def progress_path(entity):
    return os.path.join(CSV_DIR, f'{entity}_progress.txt')


def last_completed(entity):
    path = progress_path(entity)
    if not os.path.exists(path):
        return None
    with open(path, 'r', encoding='utf-8') as progress_file:
        marker = progress_file.read().strip()
    return marker or None


def update_progress(entity, jsonl_path):
    with open(progress_path(entity), 'w', encoding='utf-8') as progress_file:
        progress_file.write(jsonl_path)


def start_index(entity, files):
    marker = last_completed(entity)
    if not marker:
        return 0
    try:
        return files.index(marker) + 1
    except ValueError:
        return 0


def init_writer(file_spec, extrasaction=None):
    path = file_spec['name']
    mode = 'at' if os.path.exists(path) and os.path.getsize(path) > 0 else 'wt'
    csv_file = gzip.open(path, mode, encoding='utf-8')
    writer = csv.DictWriter(csv_file, fieldnames=file_spec['columns'],
                            extrasaction=extrasaction)
    if mode == 'wt':
        writer.writeheader()
    return csv_file, writer


def flatten_authors():
    file_spec = csv_files['authors']

    authors_csv, authors_writer = init_writer(
        file_spec['authors'], extrasaction='ignore')
    ids_csv, ids_writer = init_writer(file_spec['ids'])
    counts_by_year_csv, counts_by_year_writer = init_writer(
        file_spec['counts_by_year'])

    with authors_csv, ids_csv, counts_by_year_csv:
        files = sorted_jsonl_files('authors')
        index = start_index('authors', files)

        files_done = 0
        for jsonl_file_name in files[index:]:
            print(jsonl_file_name)
            with gzip.open(jsonl_file_name, 'r') as authors_jsonl:
                for author_json in authors_jsonl:
                    if not author_json.strip():
                        continue

                    author = json.loads(author_json)

                    if not (author_id := author.get('id')):
                        continue

                    # authors
                    author['display_name_alternatives'] = json.dumps(
                        author.get('display_name_alternatives'),
                        ensure_ascii=False)
                    author['last_known_institution'] = (
                                author.get('last_known_institution') or {}).get(
                        'id')
                    authors_writer.writerow(author)

                    # ids
                    if author_ids := author.get('ids'):
                        author_ids['author_id'] = author_id
                        ids_writer.writerow(author_ids)

                    # counts_by_year
                    if counts_by_year := author.get('counts_by_year'):
                        for count_by_year in counts_by_year:
                            count_by_year['author_id'] = author_id
                            counts_by_year_writer.writerow(count_by_year)
            update_progress('authors', jsonl_file_name)
            files_done += 1
            if FILES_PER_ENTITY and files_done >= FILES_PER_ENTITY:
                break


def flatten_topics():
    topics_csv, topics_writer = init_writer(
        csv_files['topics']['topics'], extrasaction='ignore')

    with topics_csv:
        files = sorted_jsonl_files('topics')
        index = start_index('topics', files)
        seen_topic_ids = set()
        files_done = 0
        for jsonl_file_name in files[index:]:
            print(jsonl_file_name)
            with gzip.open(jsonl_file_name, 'r') as topics_jsonl:
                for line in topics_jsonl:
                    if not line.strip():
                        continue
                    topic = json.loads(line)
                    topic['keywords'] = '; '.join(topic.get('keywords', ''))
                    if not (
                    topic_id := topic.get('id')) or topic_id in seen_topic_ids:
                        continue
                    seen_topic_ids.add(topic_id)
                    for key in ('subfield', 'field', 'domain'):
                        topic[f'{key}_id'] = topic[key]['id']
                        topic[f'{key}_display_name'] = topic[key]['display_name']
                        del topic[key]
                    updated_value = topic.get('updated') or topic.get('updated_date') or ''
                    topic['updated_date'] = updated_value
                    if 'updated' in topic:
                        del topic['updated']
                    topic['wikipedia_id'] = topic['ids'].get('wikipedia')
                    del topic['ids']
                    del topic['created_date']
                    topics_writer.writerow(topic)
            update_progress('topics', jsonl_file_name)
            files_done += 1
            if FILES_PER_ENTITY and files_done >= FILES_PER_ENTITY:
                break


def flatten_concepts():
    concepts_csv, concepts_writer = init_writer(
        csv_files['concepts']['concepts'], extrasaction='ignore')
    ancestors_csv, ancestors_writer = init_writer(
        csv_files['concepts']['ancestors'])
    counts_by_year_csv, counts_by_year_writer = init_writer(
        csv_files['concepts']['counts_by_year'])
    ids_csv, ids_writer = init_writer(csv_files['concepts']['ids'])
    related_concepts_csv, related_concepts_writer = init_writer(
        csv_files['concepts']['related_concepts'])

    with concepts_csv, ancestors_csv, counts_by_year_csv, ids_csv, related_concepts_csv:
        files = sorted_jsonl_files('concepts')
        index = start_index('concepts', files)
        seen_concept_ids = set()

        files_done = 0
        for jsonl_file_name in files[index:]:
            print(jsonl_file_name)
            with gzip.open(jsonl_file_name, 'r') as concepts_jsonl:
                for concept_json in concepts_jsonl:
                    if not concept_json.strip():
                        continue

                    concept = json.loads(concept_json)

                    if not (concept_id := concept.get(
                            'id')) or concept_id in seen_concept_ids:
                        continue

                    seen_concept_ids.add(concept_id)

                    concepts_writer.writerow(concept)

                    if concept_ids := concept.get('ids'):
                        concept_ids['concept_id'] = concept_id
                        concept_ids['umls_aui'] = json.dumps(
                            concept_ids.get('umls_aui'), ensure_ascii=False)
                        concept_ids['umls_cui'] = json.dumps(
                            concept_ids.get('umls_cui'), ensure_ascii=False)
                        ids_writer.writerow(concept_ids)

                    if ancestors := concept.get('ancestors'):
                        for ancestor in ancestors:
                            if ancestor_id := ancestor.get('id'):
                                ancestors_writer.writerow({
                                    'concept_id': concept_id,
                                    'ancestor_id': ancestor_id
                                })

                    if counts_by_year := concept.get('counts_by_year'):
                        for count_by_year in counts_by_year:
                            count_by_year['concept_id'] = concept_id
                            counts_by_year_writer.writerow(count_by_year)

                    if related_concepts := concept.get('related_concepts'):
                        for related_concept in related_concepts:
                            if related_concept_id := related_concept.get('id'):
                                related_concepts_writer.writerow({
                                    'concept_id': concept_id,
                                    'related_concept_id': related_concept_id,
                                    'score': related_concept.get('score')
                                })

            update_progress('concepts', jsonl_file_name)
            files_done += 1
            if FILES_PER_ENTITY and files_done >= FILES_PER_ENTITY:
                break


def flatten_institutions():
    file_spec = csv_files['institutions']

    institutions_csv, institutions_writer = init_writer(
        file_spec['institutions'], extrasaction='ignore')
    ids_csv, ids_writer = init_writer(file_spec['ids'])
    geo_csv, geo_writer = init_writer(file_spec['geo'])
    associated_institutions_csv, associated_institutions_writer = init_writer(
        file_spec['associated_institutions'])
    counts_by_year_csv, counts_by_year_writer = init_writer(
        file_spec['counts_by_year'])

    with institutions_csv, ids_csv, geo_csv, associated_institutions_csv, counts_by_year_csv:
        files = sorted_jsonl_files('institutions')
        index = start_index('institutions', files)
        seen_institution_ids = set()

        files_done = 0
        for jsonl_file_name in files[index:]:
            print(jsonl_file_name)
            with gzip.open(jsonl_file_name, 'r') as institutions_jsonl:
                for institution_json in institutions_jsonl:
                    if not institution_json.strip():
                        continue

                    institution = json.loads(institution_json)

                    if not (institution_id := institution.get(
                            'id')) or institution_id in seen_institution_ids:
                        continue

                    seen_institution_ids.add(institution_id)

                    # institutions
                    institution['display_name_acronyms'] = json.dumps(
                        institution.get('display_name_acronyms'),
                        ensure_ascii=False)
                    institution['display_name_alternatives'] = json.dumps(
                        institution.get('display_name_alternatives'),
                        ensure_ascii=False)
                    institutions_writer.writerow(institution)

                    # ids
                    if institution_ids := institution.get('ids'):
                        institution_ids['institution_id'] = institution_id
                        ids_writer.writerow(institution_ids)

                    # geo
                    if institution_geo := institution.get('geo'):
                        institution_geo['institution_id'] = institution_id
                        geo_writer.writerow(institution_geo)

                    # associated_institutions
                    if associated_institutions := institution.get(
                            'associated_institutions',
                            institution.get('associated_insitutions')
                            # typo in api
                    ):
                        for associated_institution in associated_institutions:
                            if associated_institution_id := associated_institution.get(
                                    'id'):
                                associated_institutions_writer.writerow({
                                    'institution_id': institution_id,
                                    'associated_institution_id': associated_institution_id,
                                    'relationship': associated_institution.get(
                                        'relationship')
                                })

                    # counts_by_year
                    if counts_by_year := institution.get('counts_by_year'):
                        for count_by_year in counts_by_year:
                            count_by_year['institution_id'] = institution_id
                            counts_by_year_writer.writerow(count_by_year)

            update_progress('institutions', jsonl_file_name)
            files_done += 1
            if FILES_PER_ENTITY and files_done >= FILES_PER_ENTITY:
                break


def flatten_publishers():
    publishers_csv, publishers_writer = init_writer(
        csv_files['publishers']['publishers'], extrasaction='ignore')
    counts_by_year_csv, counts_by_year_writer = init_writer(
        csv_files['publishers']['counts_by_year'])
    ids_csv, ids_writer = init_writer(csv_files['publishers']['ids'])

    with publishers_csv, counts_by_year_csv, ids_csv:
        files = sorted_jsonl_files('publishers')
        index = start_index('publishers', files)
        seen_publisher_ids = set()

        files_done = 0
        for jsonl_file_name in files[index:]:
            print(jsonl_file_name)
            with gzip.open(jsonl_file_name, 'r') as concepts_jsonl:
                for publisher_json in concepts_jsonl:
                    if not publisher_json.strip():
                        continue

                    publisher = json.loads(publisher_json)

                    if not (publisher_id := publisher.get(
                            'id')) or publisher_id in seen_publisher_ids:
                        continue

                    seen_publisher_ids.add(publisher_id)

                    # publishers
                    publisher['alternate_titles'] = json.dumps(
                        publisher.get('alternate_titles'), ensure_ascii=False)
                    publisher['country_codes'] = json.dumps(
                        publisher.get('country_codes'), ensure_ascii=False)
                    publishers_writer.writerow(publisher)

                    if publisher_ids := publisher.get('ids'):
                        publisher_ids['publisher_id'] = publisher_id
                        ids_writer.writerow(publisher_ids)

                    if counts_by_year := publisher.get('counts_by_year'):
                        for count_by_year in counts_by_year:
                            count_by_year['publisher_id'] = publisher_id
                            counts_by_year_writer.writerow(count_by_year)

            update_progress('publishers', jsonl_file_name)
            files_done += 1
            if FILES_PER_ENTITY and files_done >= FILES_PER_ENTITY:
                break


def flatten_sources():
    sources_csv, sources_writer = init_writer(
        csv_files['sources']['sources'], extrasaction='ignore')
    ids_csv, ids_writer = init_writer(csv_files['sources']['ids'])
    counts_by_year_csv, counts_by_year_writer = init_writer(
        csv_files['sources']['counts_by_year'])

    with sources_csv, ids_csv, counts_by_year_csv:
        files = sorted_jsonl_files('sources')
        index = start_index('sources', files)
        seen_source_ids = set()

        files_done = 0
        for jsonl_file_name in files[index:]:
            print(jsonl_file_name)
            with gzip.open(jsonl_file_name, 'r') as sources_jsonl:
                for source_json in sources_jsonl:
                    if not source_json.strip():
                        continue

                    source = json.loads(source_json)

                    if not (source_id := source.get(
                            'id')) or source_id in seen_source_ids:
                        continue

                    seen_source_ids.add(source_id)

                    source['issn'] = json.dumps(source.get('issn'))
                    sources_writer.writerow(source)

                    if source_ids := source.get('ids'):
                        source_ids['source_id'] = source_id
                        source_ids['issn'] = json.dumps(source_ids.get('issn'))
                        ids_writer.writerow(source_ids)

                    if counts_by_year := source.get('counts_by_year'):
                        for count_by_year in counts_by_year:
                            count_by_year['source_id'] = source_id
                            counts_by_year_writer.writerow(count_by_year)

            update_progress('sources', jsonl_file_name)
            files_done += 1
            if FILES_PER_ENTITY and files_done >= FILES_PER_ENTITY:
                break


def flatten_works():
    file_spec = csv_files['works']

    works_csv, works_writer = init_writer(file_spec['works'],
                                          extrasaction='ignore')
    primary_locations_csv, primary_locations_writer = init_writer(
        file_spec['primary_locations'])
    locations_csv, locations_writer = init_writer(file_spec['locations'])
    best_oa_locations_csv, best_oa_locations_writer = init_writer(
        file_spec['best_oa_locations'])
    authorships_csv, authorships_writer = init_writer(file_spec['authorships'])
    biblio_csv, biblio_writer = init_writer(file_spec['biblio'])
    topics_csv, topics_writer = init_writer(file_spec['topics'])
    concepts_csv, concepts_writer = init_writer(file_spec['concepts'])
    ids_csv, ids_writer = init_writer(file_spec['ids'], extrasaction='ignore')
    mesh_csv, mesh_writer = init_writer(file_spec['mesh'])
    open_access_csv, open_access_writer = init_writer(file_spec['open_access'])
    referenced_works_csv, referenced_works_writer = init_writer(
        file_spec['referenced_works'])
    related_works_csv, related_works_writer = init_writer(
        file_spec['related_works'])

    with works_csv, primary_locations_csv, locations_csv, best_oa_locations_csv, \
            authorships_csv, biblio_csv, topics_csv, concepts_csv, ids_csv, \
            mesh_csv, open_access_csv, referenced_works_csv, \
            related_works_csv:
        files = sorted_jsonl_files('works')
        index = start_index('works', files)

        files_done = 0
        for jsonl_file_name in files[index:]:
            print(jsonl_file_name)
            with gzip.open(jsonl_file_name, 'r') as works_jsonl:
                for work_json in works_jsonl:
                    if not work_json.strip():
                        continue

                    work = json.loads(work_json)

                    if not (work_id := work.get('id')):
                        continue

                    if (abstract := work.get(
                            'abstract_inverted_index')) is not None:
                        work['abstract_inverted_index'] = json.dumps(abstract,
                                                                     ensure_ascii=False)

                    works_writer.writerow(work)

                    if primary_location := (work.get('primary_location') or {}):
                        if primary_location.get(
                                'source') and primary_location.get(
                                'source').get('id'):
                            primary_locations_writer.writerow({
                                'work_id': work_id,
                                'source_id': primary_location['source']['id'],
                                'landing_page_url': primary_location.get(
                                    'landing_page_url'),
                                'pdf_url': primary_location.get('pdf_url'),
                                'is_oa': primary_location.get('is_oa'),
                                'version': primary_location.get('version'),
                                'license': primary_location.get('license'),
                            })

                    if locations := work.get('locations'):
                        for location in locations:
                            if location.get('source') and location.get(
                                    'source').get('id'):
                                locations_writer.writerow({
                                    'work_id': work_id,
                                    'source_id': location['source']['id'],
                                    'landing_page_url': location.get(
                                        'landing_page_url'),
                                    'pdf_url': location.get('pdf_url'),
                                    'is_oa': location.get('is_oa'),
                                    'version': location.get('version'),
                                    'license': location.get('license'),
                                })

                    if best_oa_location := (work.get('best_oa_location') or {}):
                        if best_oa_location.get(
                                'source') and best_oa_location.get(
                                'source').get('id'):
                            best_oa_locations_writer.writerow({
                                'work_id': work_id,
                                'source_id': best_oa_location['source']['id'],
                                'landing_page_url': best_oa_location.get(
                                    'landing_page_url'),
                                'pdf_url': best_oa_location.get('pdf_url'),
                                'is_oa': best_oa_location.get('is_oa'),
                                'version': best_oa_location.get('version'),
                                'license': best_oa_location.get('license'),
                            })

                    if authorships := work.get('authorships'):
                        for authorship in authorships:
                            if author_id := authorship.get('author', {}).get(
                                    'id'):
                                institutions = authorship.get('institutions')
                                institution_ids = [i.get('id') for i in
                                                   institutions]
                                institution_ids = [i for i in institution_ids if
                                                   i]
                                institution_ids = institution_ids or [None]

                                for institution_id in institution_ids:
                                    authorships_writer.writerow({
                                        'work_id': work_id,
                                        'author_position': authorship.get(
                                            'author_position'),
                                        'author_id': author_id,
                                        'institution_id': institution_id,
                                        'raw_affiliation_string': authorship.get(
                                            'raw_affiliation_string'),
                                    })

                    if biblio := work.get('biblio'):
                        biblio['work_id'] = work_id
                        biblio_writer.writerow(biblio)

                    for topic in work.get('topics', []):
                        if topic_id := topic.get('id'):
                            topics_writer.writerow({
                                'work_id': work_id,
                                'topic_id': topic_id,
                                'score': topic.get('score')
                            })

                    for concept in work.get('concepts'):
                        if concept_id := concept.get('id'):
                            concepts_writer.writerow({
                                'work_id': work_id,
                                'concept_id': concept_id,
                                'score': concept.get('score'),
                            })

                    if ids := work.get('ids'):
                        ids['work_id'] = work_id
                        ids_writer.writerow(ids)

                    for mesh in work.get('mesh'):
                        mesh['work_id'] = work_id
                        mesh_writer.writerow(mesh)

                    if open_access := work.get('open_access'):
                        open_access['work_id'] = work_id
                        open_access_writer.writerow(open_access)

                    for referenced_work in work.get('referenced_works'):
                        if referenced_work:
                            referenced_works_writer.writerow({
                                'work_id': work_id,
                                'referenced_work_id': referenced_work
                            })

                    for related_work in work.get('related_works'):
                        if related_work:
                            related_works_writer.writerow({
                                'work_id': work_id,
                                'related_work_id': related_work
                            })

            update_progress('works', jsonl_file_name)
            files_done += 1
            if FILES_PER_ENTITY and files_done >= FILES_PER_ENTITY:
                break

if __name__ == '__main__':
    tasks = {
        'topics': flatten_topics,
        'authors': flatten_authors,
        'concepts': flatten_concepts,
        'institutions': flatten_institutions,
        'publishers': flatten_publishers,
        'sources': flatten_sources,
        'works': flatten_works,
    }

    args = sys.argv[1:]

    if not args:
        flatten_topics()
        flatten_authors()
        flatten_concepts()
        flatten_institutions()
        flatten_publishers()
        flatten_sources()
        flatten_works()
    else:
        for name in args:
            fn = tasks.get(name)
            if fn is None:
                raise SystemExit(f"Unknown entity '{name}'. Valid options: {', '.join(sorted(tasks))}")
            fn()
