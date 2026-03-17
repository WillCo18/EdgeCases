import os
import glob
import pandas as pd
import psycopg2
from datetime import datetime
from dotenv import load_dotenv
import requests
import schedule
import time

load_dotenv()

def get_db_connection():
    return psycopg2.connect(os.getenv('DATABASE_URL'))

def process_csv(filepath):
    """Read a CSV, clean it, and insert into Postgres."""
    df = pd.read_csv(filepath)

    # Clean data
    df['amount'] = df['amount'].astype(float)
    df['date'] = pd.to_datetime(df['date'])
    df['customer_name'] = df['customer_name'].str.strip()

    conn = get_db_connection()
    cur = conn.cursor()

    for _, row in df.iterrows():
        cur.execute(
            """INSERT INTO transactions (customer_name, amount, date, category, region)
               VALUES (%s, %s, %s, %s, %s)""",
            (row['customer_name'], row['amount'], row['date'],
             row['category'], row['region'])
        )

    conn.commit()
    cur.close()
    conn.close()

    # Move processed file to archive
    archive_path = os.path.join(os.getenv('CSV_ARCHIVE_DIR'), os.path.basename(filepath))
    os.rename(filepath, archive_path)

    return len(df)

def run_pipeline():
    """Process all CSVs in the input directory."""
    input_dir = os.getenv('CSV_INPUT_DIR')
    csv_files = glob.glob(os.path.join(input_dir, '*.csv'))

    total_records = 0
    for filepath in csv_files:
        count = process_csv(filepath)
        total_records += count
        print(f"Processed {filepath}: {count} records")

    # Send summary to Slack
    requests.post(os.getenv('SLACK_WEBHOOK_URL'), json={
        'text': f"Pipeline complete: {total_records} records from {len(csv_files)} files"
    })

    print(f"Pipeline complete at {datetime.now()}: {total_records} total records")

def generate_daily_report():
    """Generate and send daily summary report."""
    conn = get_db_connection()

    query = """
        SELECT region, category,
               SUM(amount) as total,
               COUNT(*) as count
        FROM transactions
        WHERE date >= CURRENT_DATE - INTERVAL '1 day'
        GROUP BY region, category
        ORDER BY total DESC
    """

    df = pd.read_sql(query, conn)
    conn.close()

    report_path = f"./reports/daily_{datetime.now().strftime('%Y%m%d')}.csv"
    df.to_csv(report_path, index=False)

    requests.post(os.getenv('SLACK_WEBHOOK_URL'), json={
        'text': f"Daily report generated: {report_path}\nTotal: ${df['total'].sum():,.2f} across {df['count'].sum()} transactions"
    })

# Schedule jobs
schedule.every(15).minutes.do(run_pipeline)
schedule.every().day.at("08:00").do(generate_daily_report)

if __name__ == '__main__':
    print("Starting pipeline scheduler...")
    run_pipeline()  # Run once immediately
    while True:
        schedule.run_pending()
        time.sleep(60)
